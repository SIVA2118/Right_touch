import mongoose from "mongoose";
import JobBroadcast from "../Schemas/TechnicianBroadcast.js";
import ServiceBooking from "../Schemas/ServiceBooking.js";
import TechnicianKyc from "../Schemas/TechnicianKYC.js";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import { notifyCustomerJobAccepted, notifyJobTaken } from "../Utils/sendNotification.js";

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

/* ================= GET MY JOBS ================= */
export const getMyJobs = async (req, res) => {
  try {
    const technicianProfileId = req.user?.technicianProfileId;
    if (!technicianProfileId) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
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

    // Only show jobs that are broadcasted to this technician and not yet accepted, with geo filter
    const broadcasts = await JobBroadcast.find({
      technicianId: technicianProfileId,
      status: "sent",
    }).select("bookingId");

    const bookingIds = broadcasts.map(b => b.bookingId);

    // Fetch technician's location for geo filter
    const technician = await mongoose.model("TechnicianProfile").findById(technicianProfileId).select("location");
    let geoFilter = {};
    if (technician && technician.location && technician.location.type === "Point" && Array.isArray(technician.location.coordinates)) {
      geoFilter = {
        $or: [
          { location: { $exists: false } },
          {
            location: {
              $geoWithin: {
                $centerSphere: [
                  technician.location.coordinates,
                  10000 / 6378100 // 10km in radians
                ]
              }
            },
          },
        ],
      };
    }

    const bookings = await ServiceBooking.find({
      _id: { $in: bookingIds },
      // sk Add the requested
      status: { $in: ["broadcasted", "requested"] },
      technicianId: null,
      ...geoFilter,
    })
      .populate([
        { path: "serviceId", select: "serviceName" },
        { path: "customerId", select: "firstName lastName mobileNumber" },
        { path: "addressId", select: "name phone addressLine city state pincode latitude longitude" },
      ])
      .sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      message: "Jobs fetched successfully",
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


/* ================= RESPOND TO JOB ================= */
export const respondToJob = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { id } = req.params;
    const { status, response } = req.body;
    const finalStatus = (status || response || "").toLowerCase();
    const technicianProfileId = req.user?.technicianProfileId;
    if (!technicianProfileId) {
      await session.abortTransaction();
      return res.status(403).json({
        success: false,
        message: "Unauthorized: Technician profile not found",
      });
    }

    // Check JobBroadcast existence for this technician and booking
    const broadcast = await JobBroadcast.findOne({
      bookingId: id,
      technicianId: technicianProfileId,
      status: "sent",
    }).session(session);
    if (!broadcast) {
      await session.abortTransaction();
      return res.status(403).json({
        success: false,
        message: "Job not assigned to this technician",
      });
    }
    if (finalStatus !== "accepted" && finalStatus !== "accept") {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: "Technician not eligible for job acceptance", result: {} });
    }

    // Atomically assign booking if still open
    const booking = await ServiceBooking.findOneAndUpdate(
      { _id: id, status: { $in: ["requested", "broadcasted"] }, technicianId: null },
      { technicianId: technicianProfileId, status: "accepted", assignedAt: new Date() },
      { new: true, session }
    );
    if (!booking) {
      await session.abortTransaction();
      return res.status(409).json({ success: false, message: "Booking already taken", result: {} });
    }
    // Update JobBroadcast status for this technician
    await JobBroadcast.updateOne(
      { bookingId: id, technicianId: technicianProfileId },
      { status: "accepted" },
      { session }
    );
    // Mark all other broadcasts as expired
    await JobBroadcast.updateMany(
      { bookingId: id, technicianId: { $ne: technicianProfileId } },
      { status: "expired" },
      { session }
    );
    await session.commitTransaction();
    return res.status(200).json({ success: true, message: "Job accepted successfully", result: booking });
  } catch (err) {
    // Only abort if transaction is active (not committed/aborted) //sk
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    return res.status(500).json({ success: false, message: err.message, result: { error: err.message } });
  } finally {
    session.endSession();
  }
};
