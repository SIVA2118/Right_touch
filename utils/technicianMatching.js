import mongoose from "mongoose";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import TechnicianKyc from "../Schemas/TechnicianKYC.js";
import ServiceBooking from "../Schemas/ServiceBooking.js";
import JobBroadcast from "../Schemas/TechnicianBroadcast.js";
import Service from "../Schemas/Service.js";
import { findNearbyTechnicians } from "./findNearbyTechnicians.js";
import { broadcastJobToTechnicians } from "./sendNotification.js";

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Find eligible technicians for a given service + customer location.
 * Rules:
 * - workStatus=approved
 * - profileComplete=true
 * - availability.isOnline=true
 * - skill match on serviceId
 * - KYC verificationStatus=approved
 * - if coordinates available, prefer nearby (nearSphere)
 * - fallback to pincode/city match when geo not possible
 */
export const findEligibleTechniciansForService = async ({
  serviceId,
  address = {},
  radiusMeters = 5000,
  limit = 50,
  enableGeo = true,
  session,
} = {}) => {
  if (!serviceId || !mongoose.Types.ObjectId.isValid(serviceId)) {
    return [];
  }

  const serviceObjectId = new mongoose.Types.ObjectId(serviceId);
  const serviceIdString = String(serviceId);

  let approvedKycQuery = TechnicianKyc.find({
    verificationStatus: "approved",
    bankVerified: true
  }).select("technicianId");
  if (session) approvedKycQuery = approvedKycQuery.session(session);
  const approvedKyc = await approvedKycQuery;

  const approvedTechnicianIds = approvedKyc
    .map((d) => d.technicianId)
    .filter(Boolean);

  if (approvedTechnicianIds.length === 0) {
    return [];
  }

  const baseQuery = {
    _id: { $in: approvedTechnicianIds },
    workStatus: "approved",
    profileComplete: true,
    trainingCompleted: true,
    "availability.isOnline": true,
    $or: [
      // canonical shape: skills: [{ serviceId: ObjectId }]
      { "skills.serviceId": serviceObjectId },
      // legacy/dirty data: string stored instead of ObjectId
      { "skills.serviceId": serviceIdString },
    ],
  };

  const lat = Number(address?.latitude);
  const lng = Number(address?.longitude);

  const hasCoords =
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180;

  // 1) Prefer geo query when possible (requires technicians to have `location`)
  if (enableGeo && hasCoords) {
    // Only match technicians who actually have a valid GeoJSON Point.
    // Many profiles may have latitude/longitude strings but no GeoJSON `location`.
    const geoQuery = {
      ...baseQuery,
      $and: [
        { "location.type": "Point" },
        { "location.coordinates.0": { $type: "number" } },
        { "location.coordinates.1": { $type: "number" } },
        {
          location: {
            $nearSphere: {
              $geometry: {
                type: "Point",
                coordinates: [lng, lat],
              },
              $maxDistance: radiusMeters,
            },
          },
        },
      ],
    };

    let nearbyQuery = TechnicianProfile.find(geoQuery).select("_id").limit(limit);
    if (session) nearbyQuery = nearbyQuery.session(session);
    const nearby = await nearbyQuery;

    if (nearby.length > 0) return nearby;
  }

  // 2) Fallback: pincode / city matching (no coordinates available or no geo matches)
  const fallbackQuery = { ...baseQuery };

  if (address?.pincode) {
    fallbackQuery.pincode = String(address.pincode).trim();
  } else if (address?.city) {
    fallbackQuery.city = new RegExp(`^${escapeRegExp(String(address.city).trim())}$`, "i");
  } else if (address?.state) {
    fallbackQuery.state = new RegExp(`^${escapeRegExp(String(address.state).trim())}$`, "i");
  }

  let fallbackFindQuery = TechnicianProfile.find(fallbackQuery)
    .select("_id")
    .limit(limit);
  if (session) fallbackFindQuery = fallbackFindQuery.session(session);
  return fallbackFindQuery;
};

/**
 * Unifies the logic for matching and broadcasting a booking to technicians.
 * Used by both Booking Creation (single) and Checkout (cart).
 *
 * @param {string} bookingId - The ID of the booking to process
 * @param {Object} io - Socket.io instance for real-time notifications
 */
export const matchAndBroadcastBooking = async (bookingId, io) => {
  try {
    const booking = await ServiceBooking.findById(bookingId);
    if (!booking) {
      console.error(`❌ matchAndBroadcastBooking: Booking ${bookingId} not found`);
      return { success: false, message: "Booking not found" };
    }

    if (booking.status !== "requested") {
      // Already processed or cancelled
      return { success: false, message: `Booking status is ${booking.status}` };
    }

    const service = await Service.findById(booking.serviceId);
    if (!service) {
      console.error(`❌ matchAndBroadcastBooking: Service ${booking.serviceId} not found`);
      return { success: false, message: "Service not found" };
    }

    // Resolve Location for Matching
    // Booking now has 'location' GeoJSON and 'addressSnapshot'
    // We prioritize the GeoJSON coordinates.
    let latitude, longitude;

    if (booking.location && booking.location.coordinates) {
      // GeoJSON is [lng, lat]
      longitude = booking.location.coordinates[0];
      latitude = booking.location.coordinates[1];
    } else if (booking.addressSnapshot) {
      latitude = booking.addressSnapshot.latitude;
      longitude = booking.addressSnapshot.longitude;
    }

    if (!latitude || !longitude) {
      console.error(`❌ matchAndBroadcastBooking: No coordinates for booking ${bookingId}`);
      return { success: false, message: "No coordinates for booking" };
    }

    // 1. Find Eligible Technicians (Skills, Online, KYC Approved, Blocked, etc.)
    // Note: We use the helper which checks skills & general availability
    const eligibleTechnicians = await findEligibleTechniciansForService({
      serviceId: booking.serviceId,
      address: { latitude, longitude },
      enableGeo: false, // We will do strict geo search next
    });

    const eligibleIds = eligibleTechnicians.map(t => t._id);

    if (eligibleIds.length === 0) {
      console.log(`⚠️ No eligible (online/skilled) technicians for booking ${bookingId}`);
      // Optional: Update booking status or log
      return { success: true, count: 0, message: "No eligible technicians found" };
    }

    // 2. Geo & Radius Search (Progressive)
    const baseRadius = booking.radius || 3000; // Default usually 3km or 5km
    const radiusSteps = [baseRadius, baseRadius * 2, baseRadius * 4];

    let nearbyTechnicians = [];

    for (const radius of radiusSteps) {
      nearbyTechnicians = await findNearbyTechnicians({
        latitude,
        longitude,
        radiusMeters: radius,
        limit: 20, // Max technicians to ping at once
        technicianIds: eligibleIds, // Filter the eligible ones by distance
      });

      if (nearbyTechnicians.length > 0) break;
    }

    if (nearbyTechnicians.length === 0) {
      console.log(`⚠️ No nearby technicians found for booking ${bookingId}`);
      await ServiceBooking.updateOne({ _id: booking._id }, { broadcastedAt: null });
      return { success: true, count: 0, message: "No nearby technicians found" };
    }

    // 3. Create JobBroadcast Records
    const technicianIds = nearbyTechnicians.map(t => t._id.toString());
    const jobBroadcastDocs = technicianIds.map(technicianId => ({
      bookingId: booking._id,
      technicianId,
      status: "sent",
      expiresAt: new Date(Date.now() + 10 * 60 * 1000), // 10 minutes expiry?
    }));

    try {
      await JobBroadcast.insertMany(jobBroadcastDocs, { ordered: false });
    } catch (e) {
      // Ignore duplicates
    }

    // 4. Update Booking Status
    await ServiceBooking.updateOne(
      { _id: booking._id },
      { status: "broadcasted", broadcastedAt: new Date() }
    );

    // 5. Send Notifications (Push + Socket)
    await broadcastJobToTechnicians(
      io,
      technicianIds,
      {
        bookingId: booking._id,
        serviceId: service._id,
        serviceName: service.serviceName,
        baseAmount: booking.baseAmount,
        address: booking.address, // legacy string or snapshot line
        scheduledAt: booking.scheduledAt,
      }
    );

    console.log(`✅ matchAndBroadcastBooking: Broadcasted booking ${bookingId} to ${technicianIds.length} techs`);
    return { success: true, count: technicianIds.length };

  } catch (error) {
    console.error("❌ matchAndBroadcastBooking Error:", error);
    return { success: false, error: error.message };
  }
};
//sk
/**
 * Searches for existing unassigned jobs that match a technician's profile
 * and broadcasts them specifically to that technician.
 */
export const broadcastPendingJobsToTechnician = async (technicianProfileId, io) => {
  try {
    const tech = await TechnicianProfile.findById(technicianProfileId);

    // Guard: Only approved and online technicians receive jobs
    if (!tech || tech.workStatus !== "approved" || !tech.availability?.isOnline) return;

    const lat = tech.location.coordinates[1];
    const lng = tech.location.coordinates[0];

    // THE CALCULATION: Find 'requested' jobs within 10km search limit
    const eligibleBookings = await ServiceBooking.find({
      serviceId: { $in: tech.skills.map(s => s.serviceId) },
      technicianId: null,
      status: { $in: ["requested", "broadcasted"] },
      location: {
        $nearSphere: {
          $geometry: { type: "Point", coordinates: [lng, lat] },
          $maxDistance: 10000, // 10km limit
        },
      },
    }).limit(20);

    // Create broadcast records for each matched job
    for (const booking of eligibleBookings) {
      // Check if broadcast already exists
      const existingBroadcast = await JobBroadcast.findOne({
        bookingId: booking._id,
        technicianId: technicianProfileId,
      });

      if (!existingBroadcast) {
        await JobBroadcast.create({
          bookingId: booking._id,
          technicianId: technicianProfileId,
          status: "sent",
          expiresAt: new Date(Date.now() + 10 * 60 * 1000), // 10 minutes expiry
        });

        const service = await Service.findById(booking.serviceId);
        if (service) {
          await broadcastJobToTechnicians(
            io,
            [technicianProfileId.toString()],
            {
              bookingId: booking._id,
              serviceId: service._id,
              serviceName: service.serviceName,
              baseAmount: booking.baseAmount,
              address: booking.address,
              scheduledAt: booking.scheduledAt,
            }
          );
        }
      }
    }
  } catch (error) {
    console.error("Match Calculation Error:", error);
  }
};

