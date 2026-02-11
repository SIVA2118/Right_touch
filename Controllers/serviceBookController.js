import ServiceBooking from "../Schemas/ServiceBooking.js";
import JobBroadcast from "../Schemas/TechnicianBroadcast.js";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import TechnicianKyc from "../Schemas/TechnicianKYC.js";
import Service from "../Schemas/Service.js";
import Address from "../Schemas/Address.js";
import mongoose from "mongoose";
import { broadcastJobToTechnicians } from "../Utils/sendNotification.js";
import { findEligibleTechniciansForService } from "../Utils/technicianMatching.js";
import { findNearbyTechnicians } from "../Utils/findNearbyTechnicians.js";
import { settleBookingEarningsIfEligible } from "../Utils/settlement.js";
import { matchAndBroadcastBooking } from "../Utils/technicianMatching.js";
import { resolveUserLocation } from "../Utils/resolveUserLocation.js";

const toNumber = value => {
  const num = Number(value);
  return Number.isNaN(num) ? NaN : num;
};


const toFiniteNumber = (v) => {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" && v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/* ================= TECHNICIAN ACTIVATION CHECK ================= */
const checkTechnicianActivation = async (technicianProfileId) => {
  try {
    // Fetch KYC data
    const kyc = await TechnicianKyc.findOne({
      technicianId: technicianProfileId,
    }).select("verificationStatus bankVerified");

    // Check KYC approval
    if (!kyc || kyc.verificationStatus !== "approved") {
      return {
        isActive: false,
        message: "Complete KYC, bank verification, and training to activate technician account",
      };
    }

    // Check bank verification
    if (!kyc.bankVerified) {
      return {
        isActive: false,
        message: "Complete KYC, bank verification, and training to activate technician account",
      };
    }

    // Fetch technician profile
    const profile = await TechnicianProfile.findById(technicianProfileId).select("trainingCompleted");

    // Check training completion
    if (!profile || !profile.trainingCompleted) {
      return {
        isActive: false,
        message: "Complete KYC, bank verification, and training to activate technician account",
      };
    }

    // All conditions met
    return {
      isActive: true,
      message: "Technician account is active",
    };
  } catch (error) {
    return {
      isActive: false,
      message: error.message,
    };
  }
};


export const createBooking = async (req, res) => {
  try {
    if (req.user?.role !== "Customer") {
      return res.status(403).json({ success: false, message: "Customer access only", result: {} });
    }
    if (!req.user.userId || !mongoose.Types.ObjectId.isValid(req.user.userId)) {
      return res.status(401).json({ success: false, message: "Invalid token user", result: {} });
    }
    const customerId = req.user.userId;

    const { serviceId, baseAmount, address, scheduledAt } = req.body;
    const radiusInput = toFiniteNumber(req.body?.radius);
    const addressId = typeof req.body?.addressId === "string" ? req.body.addressId.trim() : req.body?.addressId;

    const addressLineInput = typeof req.body?.addressLine === "string" ? req.body.addressLine.trim() : "";
    const cityInput = typeof req.body?.city === "string" ? req.body.city.trim() : undefined;
    const stateInput = typeof req.body?.state === "string" ? req.body.state.trim() : undefined;
    const pincodeInput = typeof req.body?.pincode === "string" ? req.body.pincode.trim() : undefined;

    const latInput =
      req.body?.latitude !== undefined
        ? toFiniteNumber(req.body.latitude)
        : toFiniteNumber(req.body?.location?.latitude);
    const lngInput =
      req.body?.longitude !== undefined
        ? toFiniteNumber(req.body.longitude)
        : toFiniteNumber(req.body?.location?.longitude);

    const hasCoords = latInput !== null && lngInput !== null;

    if (!serviceId || baseAmount == null || (!address && !addressId && !addressLineInput && !hasCoords)) {
      return res.status(400).json({
        success: false,
        message: "All fields required",
        result: {},
      });
    }

    // 🔒 Validate ObjectId
    if (!mongoose.Types.ObjectId.isValid(serviceId)) {
      return res.status(400).json({ success: false, message: "Invalid serviceId format", result: {} });
    }

    const baseAmountNum = toNumber(baseAmount);
    if (Number.isNaN(baseAmountNum) || baseAmountNum < 0) {
      return res.status(400).json({ success: false, message: "baseAmount must be a non-negative number", result: {} });
    }

    const service = await Service.findById(serviceId);
    if (!service || !service.isActive) {
      return res.status(404).json({ success: false, message: "Service not found or inactive", result: {} });
    }

    // 🔁 Decision Logic: Address ID vs Current Location
    const resolvedLocation = await resolveUserLocation({
      locationType: req.body.locationType,
      addressId: req.body.addressId,
      latitude: req.body.latitude,
      longitude: req.body.longitude,
      userId: customerId,
    });

    if (!resolvedLocation.success) {
      return res.status(resolvedLocation.statusCode).json({
        success: false,
        message: resolvedLocation.message,
        result: {},
      });
    }

    // Calculate split
    const commissionPct = typeof service.commissionPercentage === "number" ? service.commissionPercentage : 0;
    const commissionAmt = Math.round((baseAmountNum * commissionPct) / 100);
    const techAmt = baseAmountNum - commissionAmt;

    // 1️⃣ Create booking
    const bookingDoc = {
      customerId,
      serviceId,
      baseAmount: baseAmountNum,
      // ✅ Swiggy-Style Location Snapshot
      locationType: resolvedLocation.locationType,
      addressSnapshot: resolvedLocation.addressSnapshot,

      // Legacy/Display address string
      address: resolvedLocation.addressSnapshot.addressLine || "Pinned Location",
      commissionPercentage: commissionPct,
      commissionAmount: commissionAmt,
      technicianAmount: techAmt,
      address: addressForBooking,
      scheduledAt,
      status: "requested",
      radius: radiusInput ?? 500,
    };


    // Only save addressId if we actually used a saved address
    if (resolvedLocation.addressId) {
      bookingDoc.addressId = resolvedLocation.addressId;
    }

    // GeoJSON point for geospatial queries
    bookingDoc.location = {
      type: "Point",
      coordinates: [resolvedLocation.longitude, resolvedLocation.latitude],
    };

    const hasCoordsForBooking = true; // Always true with new utility

    const booking = await ServiceBooking.create(bookingDoc);

    // 2️⃣ Smart matching & broadcast (Unified Logic)
    const broadcastResult = await matchAndBroadcastBooking(booking._id, req.io);

    return res.status(201).json({
      success: true,
      message: broadcastResult.count > 0
        ? "Booking created & broadcasted"
        : "Booking created (no technicians available yet)",
      result: {
        booking,
        broadcastCount: broadcastResult.count || 0,
        status: broadcastResult.count > 0 ? "broadcasted" : "no_technicians_available",
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
      result: { error: error.message },
    });
  }
};


/* =====================================================
   GET BOOKINGS (ROLE BASED)
===================================================== */
export const getBookings = async (req, res) => {
  try {
    let filter = {};

    if (req.user.role === "Customer") {
      if (!req.user.userId || !mongoose.Types.ObjectId.isValid(req.user.userId)) {
        return res.status(401).json({ success: false, message: "Invalid token user", result: {} });
      }
      filter.customerId = req.user.userId;
    }

    if (req.user.role === "Technician") {
      const technicianProfileId = req.user?.technicianProfileId;
      if (!technicianProfileId || !mongoose.Types.ObjectId.isValid(technicianProfileId)) {
        return res.status(401).json({ success: false, message: "Invalid token profile", result: {} });
      }
      filter.technicianId = technicianProfileId;
    }

    // For Admin: no filter, shows all bookings
    // For Customer/Technician: filtered by their ID

    const bookings = await ServiceBooking.find(filter)
      .populate("customerId", "fname lname mobileNumber email")
      .populate("serviceId", "serviceName serviceType serviceCost")
      .populate({
        path: "technicianId",
        select: "userId workStatus",
        populate: {
          path: "userId",
          select: "fname lname mobileNumber"
        }
      })
      .sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      message: "Bookings fetched successfully",
      result: bookings,
    });
  } catch (error) {
    console.error("getBookings:", error);
    return res.status(500).json({
      success: false,
      message: error.message,
      result: { error: error.message },
    });
  }
};

/* =====================================================
   GET BOOKING FOR (CUSTOMER)
===================================================== */

export const getCustomerBookings = async (req, res) => {
  try {
    if (req.user?.role !== "Customer") {
      return res.status(403).json({ success: false, message: "Customer access only", result: {} });
    }
    if (!req.user.userId || !mongoose.Types.ObjectId.isValid(req.user.userId)) {
      return res.status(401).json({ success: false, message: "Invalid token user", result: {} });
    }
    const bookings = await ServiceBooking.find({
      customerId: req.user.userId,
    })
      .populate("serviceId", "serviceName serviceType serviceCost")
      .populate({
        path: "technicianId",
        select: "userId workStatus",
        populate: {
          path: "userId",
          select: "fname lname mobileNumber"
        }
      })
      .sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      message: "Customer booking history",
      result: bookings,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
      result: { error: err.message },
    });
  }
};

/* =====================================================
   GET JOB FOR (TECHNICIAN)
===================================================== */

export const getTechnicianJobHistory = async (req, res) => {
  try {
    if (req.user?.role !== "Technician") {
      return res.status(403).json({
        success: false,
        message: "Access denied",
        result: {},
      });
    }

    const technicianProfileId = req.user?.technicianProfileId;
    if (!technicianProfileId) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
        result: {},
      });
    }

    const technicianId = req.technician._id;
    const userId = req.technician.userId;
    // Check technician activation status
    const activation = await checkTechnicianActivation(technicianProfileId);
    if (!activation.isActive) {
      return res.status(200).json({
        success: true,
        message: activation.message,
        result: [],
      });
    }

    const jobs = await ServiceBooking.find({
      technicianId: { $in: [technicianId, userId] },
      status: { $in: ["completed", "cancelled"] },
    })
      .populate("customerId", "fname lname mobileNumber email")
      .populate("serviceId", "serviceName serviceType serviceCost")
      .sort({ updatedAt: -1 });

    return res.status(200).json({
      success: true,
      message: "Job history fetched",
      result: jobs,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
      result: { error: err.message },
    });
  }
};


/* =====================================================
   GET CURRENT JOBS (TECHNICIAN & OWNER)
===================================================== */
export const getTechnicianCurrentJobs = async (req, res) => {
  try {
    const userRole = req.user?.role;

    // Validate role access
    if (userRole !== "Technician" && userRole !== "Owner") {
      return res.status(403).json({
        success: false,
        message: "Access denied. Technician or Owner access only.",
        result: {},
      });
    }



    // sk Add the requested status
    // For Technician, we get profileId from token. For Owner, we might get all jobs or filter differently.

    let technicianId = null;
    let userId = req.user.userId;

    if (userRole === "Technician") {
      technicianId = req.user?.technicianProfileId;
    }
    if (userRole === "Technician") {
      // Technician: Only their own jobs
      const technicianProfileId = req.user?.technicianProfileId;
      if (!technicianProfileId) {
        return res.status(401).json({
          success: false,
          message: "Unauthorized. Technician profile not found.",
          result: {},
        });
      }

      // Check technician activation status
      const activation = await checkTechnicianActivation(technicianProfileId);
      if (!activation.isActive) {
        return res.status(200).json({
          success: true,
          message: activation.message,
          result: [],
        });
      }

      technicianId = technicianProfileId;
    }

    // sk Add the requested status
    // Search by both ObjectId and String versions to be safe
    const idList = [
      technicianId,
      userId,
      technicianId ? technicianId.toString() : null,
      userId ? userId.toString() : null
    ].filter(Boolean);
    // If role is Owner: no additional filter, get all current jobs

    const jobs = await ServiceBooking.find({
      technicianId: { $in: idList },
      status: { $in: ["accepted", "on_the_way", "reached", "in_progress"] },
    })
      .populate({
        path: "customerId",
        select: "fname lname mobileNumber email",
      })
      .populate({
        path: "technicianId",
        populate: {
          path: "userId",
          select: "fname lname mobileNumber email",
        },
        select: "userId profileImage locality workStatus",
      })
      .populate({
        path: "addressId",
        select: "name phone addressLine city state pincode latitude longitude",
      })
      .populate({
        path: "serviceId",
        select: "serviceName serviceType",
      })
      .sort({ createdAt: -1 });

    // Format response for better readability
    const formattedJobs = jobs.map((job) => {
      const jobObj = job.toObject();

      // Format customer details
      const customer = jobObj.customerId
        ? {
          firstName: jobObj.customerId.fname || "",
          lastName: jobObj.customerId.lname || "",
          mobileNumber: jobObj.customerId.mobileNumber || "",
          email: jobObj.customerId.email || "",
        }
        : null;

      // Format technician details
      const technician = jobObj.technicianId
        ? {
          firstName: jobObj.technicianId.userId?.fname || "",
          lastName: jobObj.technicianId.userId?.lname || "",
          mobileNumber: jobObj.technicianId.userId?.mobileNumber || "",
          email: jobObj.technicianId.userId?.email || "",
          profileImage: jobObj.technicianId.profileImage || null,
          locality: jobObj.technicianId.locality || "",
          workStatus: jobObj.technicianId.workStatus || "",
        }
        : null;

      // Format service details
      const service = jobObj.serviceId
        ? {
          serviceName: jobObj.serviceId.serviceName || "",
          serviceType: jobObj.serviceId.serviceType || "",
        }
        : null;

      // Format address details
      //sk
      let address = null;
      if (jobObj.addressId) {
        address = {
          name: jobObj.addressId.name || "",
          phone: jobObj.addressId.phone || "",
          addressLine: jobObj.addressId.addressLine || "",
          city: jobObj.addressId.city || "",
          state: jobObj.addressId.state || "",
          pincode: jobObj.addressId.pincode || "",
          //sk
          latitude: jobObj.addressId.latitude,
          longitude: jobObj.addressId.longitude,
        };
      } else if (jobObj.addressSnapshot) {
        address = {
          name: jobObj.addressSnapshot.name || "",
          phone: jobObj.addressSnapshot.phone || "",
          addressLine: jobObj.addressSnapshot.addressLine || "",
          city: jobObj.addressSnapshot.city || "",
          state: jobObj.addressSnapshot.state || "",
          pincode: jobObj.addressSnapshot.pincode || "",
          latitude: jobObj.addressSnapshot.latitude,
          longitude: jobObj.addressSnapshot.longitude,
        };
      }

      // Fallback to GeoJSON if needed
      if (address && (!address.latitude || !address.longitude) && jobObj.location?.coordinates) {
        address.longitude = jobObj.location.coordinates[0];
        address.latitude = jobObj.location.coordinates[1];
      }

      return {
        jobId: jobObj._id,
        status: jobObj.status,
        customer,
        technician,
        service,
        address,
        baseAmount: jobObj.baseAmount,
        scheduledAt: jobObj.scheduledAt,
        createdAt: jobObj.createdAt,
        acceptedAt: jobObj.assignedAt,
        paymentStatus: jobObj.paymentStatus,
      };
    });

    return res.status(200).json({
      success: true,
      message: `Active jobs fetched for ${userRole}`,
      result: formattedJobs,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
      result: { error: err.message },
    });
  }
};


/* =====================================================
   UPDATE BOOKING STATUS (TECHNICIAN)
===================================================== */
export const updateBookingStatus = async (req, res) => {
  try {
    const userRole = req.user?.role;

    const bookingId = req.params.id;
    const { status } = req.body;

    // 🔒 Validate ObjectId
    if (!mongoose.Types.ObjectId.isValid(bookingId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid booking ID format",
        result: {},
      });
    }

    const allowedStatus = [
      "on_the_way",
      "reached",
      "in_progress",
      "completed",
    ];

    if (!bookingId || !allowedStatus.includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Invalid status",
        result: {},
      });
    }

    const technicianProfileId = req.user?.technicianProfileId;
    let booking = await ServiceBooking.findById(bookingId);
    if (!booking) {
      return res.status(404).json({
        success: false,
        message: "Booking not found",
        result: {},
      });
    }
    if (userRole !== "Technician") {
      return res.status(403).json({ success: false, message: "Only technician can update status", result: {} });
    }
    if (!technicianProfileId || !booking.technicianId || booking.technicianId.toString() !== technicianProfileId.toString()) {
      return res.status(403).json({ success: false, message: "Access denied for this booking", result: {} });
    }
    // Check technician approval status
    const technician = await TechnicianProfile.findById(technicianProfileId);
    if (!technician) {
      return res.status(404).json({
        success: false,
        message: "Technician profile not found",
        result: {},
      });
    }
    if (!technician.profileComplete) {
      return res.status(403).json({
        success: false,
        message: "Please complete your profile first",
        result: { profileComplete: false },
      });
    }

    // Check technician activation status (KYC + Bank + Training)
    const activation = await checkTechnicianActivation(technicianProfileId);
    if (!activation.isActive) {
      return res.status(403).json({
        success: false,
        message: activation.message,
        result: {},
      });
    }

    // Check workStatus
    if (technician.workStatus !== "approved") {
      return res.status(403).json({
        success: false,
        message: "Your account must be approved by owner before working. Status: " + technician.workStatus,
        result: { workStatus: technician.workStatus },
      });
    }
    booking.status = status;
    await booking.save();
    if (status === "completed") {
      // If payment is already verified, credit technician wallet (idempotent)
      await settleBookingEarningsIfEligible(booking._id);
    }
    return res.status(200).json({
      success: true,
      message: "Status updated",
      result: booking,
    });
  } catch (error) {
    console.error("updateBookingStatus:", error);
    return res.status(500).json({
      success: false,
      message: error.message,
      result: { error: error.message },
    });
  }
};


/* =====================================================
   CANCEL BOOKING (CUSTOMER)
===================================================== */
export const cancelBooking = async (req, res) => {
  try {
    const { id } = req.params;

    // 🔒 Validate ObjectId
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid booking ID format",
        result: {},
      });
    }

    // 1️⃣ Find booking
    const booking = await ServiceBooking.findById(id);

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: "Booking not found",
        result: {},
      });
    }

    // 2️⃣ Only CUSTOMER who created booking can cancel
    if (req.user.role !== "Customer") {
      return res.status(403).json({
        success: false,
        message: "Only customer can cancel booking",
        result: {},
      });
    }

    if (!req.user.userId || !mongoose.Types.ObjectId.isValid(req.user.userId)) {
      return res.status(401).json({ success: false, message: "Invalid token user", result: {} });
    }

    if (booking.customerId.toString() !== req.user.userId.toString()) {
      return res.status(403).json({
        success: false,
        message: "Access denied",
        result: {},
      });
    }

    // 3️⃣ Prevent double cancel
    if (booking.status === "cancelled") {
      return res.status(400).json({
        success: false,
        message: "Booking already cancelled",
        result: {},
      });
    }

    // 4️⃣ Prevent cancel after work completed
    if (booking.status === "completed") {
      return res.status(400).json({
        success: false,
        message: "Completed booking cannot be cancelled",
        result: {},
      });
    }

    // 5️⃣ OPTIONAL (recommended)
    // Prevent cancel once technician is working
    if (["on_the_way", "reached", "in_progress"].includes(booking.status)) {
      return res.status(400).json({
        success: false,
        message: "Booking cannot be cancelled once technician started work",
        result: {},
      });
    }

    // 6️⃣ Cancel booking
    booking.status = "cancelled";
    await booking.save();

    return res.status(200).json({
      success: true,
      message: "Booking cancelled successfully",
      result: booking,
    });
  } catch (error) {
    console.error("cancelBooking:", error);
    return res.status(500).json({
      success: false,
      message: error.message,
      result: { error: error.message },
    });
  }
};
