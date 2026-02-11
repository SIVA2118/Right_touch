import mongoose from "mongoose";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import Service from "../Schemas/Service.js";
import ServiceBooking from "../Schemas/ServiceBooking.js";
import JobBroadcast from "../Schemas/TechnicianBroadcast.js";
import { broadcastPendingJobsToTechnician } from "../Utils/technicianMatching.js";

// ================= UPDATE TECHNICIAN LIVE LOCATION ================= //sk
export const updateTechnicianLocation = async (req, res) => {
  try {
    const technicianProfileId = req.user?.technicianProfileId;
    const { latitude, longitude } = req.body;

    if (!technicianProfileId || !mongoose.Types.ObjectId.isValid(technicianProfileId)) {
      return res.status(401).json({ success: false, message: "Unauthorized", result: {} });
    }
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return res.status(400).json({ success: false, message: "Invalid coordinates", result: {} });
    }


    // Only update if moved > 25 meters
    const oldProfile = await TechnicianProfile.findById(technicianProfileId).select("location");
    let shouldUpdate = true;
    if (oldProfile && oldProfile.location && Array.isArray(oldProfile.location.coordinates)) {
      const [oldLng, oldLat] = oldProfile.location.coordinates;
      const toRad = deg => (deg * Math.PI) / 180;
      const R = 6371000; // meters
      const dLat = toRad(latitude - oldLat);
      const dLng = toRad(longitude - oldLng);
      const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRad(oldLat)) * Math.cos(toRad(latitude)) *
        Math.sin(dLng / 2) * Math.sin(dLng / 2);
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      const dist = R * c;
      if (dist < 25) shouldUpdate = false;
    }
    if (!shouldUpdate) {
      return res.json({ success: true, message: "Location unchanged (moved < 25m)" });
    }
    await TechnicianProfile.updateOne(
      { _id: technicianProfileId },
      {
        location: {
          type: "Point",
          coordinates: [longitude, latitude],
        },
        "availability.isOnline": true,
      }
    );


    //sk
    // 2. 🔥 Trigger calculation: Find matching jobs nearby and push them to this tech
    await broadcastPendingJobsToTechnician(technicianProfileId, req.io);

    return res.json({ success: true, message: "Location updated and jobs calculated" });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message, result: { error: error.message } });
  }
};

const isValidObjectId = mongoose.Types.ObjectId.isValid;
const TECHNICIAN_STATUSES = ["pending", "trained", "approved", "suspended"];

const validateSkills = (skills) => {
  if (skills === undefined) return true;
  if (!Array.isArray(skills)) return false;
  return skills.every((item) =>
    item && item.serviceId && isValidObjectId(item.serviceId)
  );
};

const normalizeServiceIdsInput = (body) => {
  const raw = body?.serviceIds ?? body?.serviceId;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];

  const normalized = list
    .map((v) => (typeof v === "string" ? v.trim() : v))
    .filter(Boolean)
    .map(String);

  // de-dupe
  return Array.from(new Set(normalized));
};

/* ================= ADD TECHNICIAN SKILLS (APPEND) ================= */
export const addTechnicianSkills = async (req, res) => {
  try {
    const technicianProfileId = req.user?.technicianProfileId;

    if (!technicianProfileId || !isValidObjectId(technicianProfileId)) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
        result: {},
      });
    }

    const serviceIds = normalizeServiceIdsInput(req.body);
    if (serviceIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: "serviceIds (or serviceId) is required",
        result: {},
      });
    }

    const invalidIds = serviceIds.filter((id) => !isValidObjectId(id));
    if (invalidIds.length > 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid serviceIds",
        result: { invalidIds },
      });
    }

    const serviceObjectIds = serviceIds.map((id) => new mongoose.Types.ObjectId(id));

    // Optional safety: ensure services exist & active
    const activeServices = await Service.find({ _id: { $in: serviceObjectIds }, isActive: true })
      .select("_id")
      .lean();
    const activeSet = new Set(activeServices.map((s) => String(s._id)));
    const missingOrInactive = serviceIds.filter((id) => !activeSet.has(String(id)));
    if (missingOrInactive.length > 0) {
      return res.status(404).json({
        success: false,
        message: "Some services were not found or inactive",
        result: { missingOrInactive },
      });
    }

    const technician = await TechnicianProfile.findByIdAndUpdate(
      technicianProfileId,
      {
        $addToSet: {
          skills: { $each: serviceObjectIds.map((sid) => ({ serviceId: sid })) },
        },
      },
      { new: true, runValidators: true }
    )
      .populate("skills.serviceId", "serviceName")
      .select("-password");

    if (!technician) {
      return res.status(404).json({
        success: false,
        message: "Technician profile not found",
        result: {},
      });
    }

    return res.status(200).json({
      success: true,
      message: "Skills added successfully",
      result: technician,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Server error",
      result: { error: error.message },
    });
  }
};

/* ================= REMOVE TECHNICIAN SKILLS ================= */
export const removeTechnicianSkills = async (req, res) => {
  try {
    const technicianProfileId = req.user?.technicianProfileId;

    if (!technicianProfileId || !isValidObjectId(technicianProfileId)) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
        result: {},
      });
    }

    const serviceIds = normalizeServiceIdsInput(req.body);
    if (serviceIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: "serviceIds (or serviceId) is required",
        result: {},
      });
    }

    const invalidIds = serviceIds.filter((id) => !isValidObjectId(id));
    if (invalidIds.length > 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid serviceIds",
        result: { invalidIds },
      });
    }

    const serviceObjectIds = serviceIds.map((id) => new mongoose.Types.ObjectId(id));

    const technician = await TechnicianProfile.findByIdAndUpdate(
      technicianProfileId,
      {
        $pull: {
          skills: { serviceId: { $in: serviceObjectIds } },
        },
      },
      { new: true, runValidators: true }
    )
      .populate("skills.serviceId", "serviceName")
      .select("-password");

    if (!technician) {
      return res.status(404).json({
        success: false,
        message: "Technician profile not found",
        result: {},
      });
    }

    return res.status(200).json({
      success: true,
      message: "Skills removed successfully",
      result: technician,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Server error",
      result: { error: error.message },
    });
  }
};

/* ================= UPDATE TECHNICIAN SKILLS ================= */
export const createTechnician = async (req, res) => {
  try {
    const technicianProfileId = req.user?.technicianProfileId;
    const { skills } = req.body;

    if (!technicianProfileId || !isValidObjectId(technicianProfileId)) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
        result: {},
      });
    }

    if (!validateSkills(skills)) {
      return res.status(400).json({
        success: false,
        message: "Invalid skills format",
        result: {},
      });
    }

    // Ensure only users with Technician role can update skills
    if (req.user?.role !== "Technician") {
      return res.status(403).json({
        success: false,
        message: "Only users with Technician role can update skills",
        result: {},
      });
    }

    const technician = await TechnicianProfile.findByIdAndUpdate(
      technicianProfileId,
      { skills },
      { new: true, runValidators: true }
    ).select("-password");

    if (!technician) {
      return res.status(404).json({
        success: false,
        message: "Technician profile not found",
        result: {},
      });
    }

    return res.status(200).json({
      success: true,
      message: "Skills updated successfully",
      result: technician,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Server error",
      result: { error: error.message },
    });
  }
};

/* ================= GET ALL TECHNICIANS ================= */
export const getAllTechnicians = async (req, res) => {
  try {
    const { workStatus, search } = req.query;
    const query = {};

    if (workStatus) {
      if (!TECHNICIAN_STATUSES.includes(workStatus)) {
        return res.status(400).json({
          success: false,
          message: "Invalid workStatus filter",
          result: {},
        });
      }
      query.workStatus = workStatus;
    }

    if (search) {
      query.$or = [
        { firstName: { $regex: search, $options: "i" } },
        { lastName: { $regex: search, $options: "i" } },
        { workStatus: { $regex: search, $options: "i" } },
      ];
    }

    const technicians = await TechnicianProfile.find(query)
      .populate("skills.serviceId", "serviceName")
      .select("-password");

    return res.status(200).json({
      success: true,
      message: "Technicians fetched successfully",
      result: technicians,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Server error",
      result: { error: error.message },
    });
  }
};

/* ================= GET TECHNICIAN BY ID ================= */
export const getTechnicianById = async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid Technician ID",
        result: {},
      });
    }

    const technician = await TechnicianProfile.findById(id)
      .populate("skills.serviceId", "serviceName")
      .select("-password");

    if (!technician) {
      return res.status(404).json({
        success: false,
        message: "Technician not found",
        result: {},
      });
    }

    return res.status(200).json({
      success: true,
      message: "Technician fetched successfully",
      result: technician,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Server error",
      result: { error: error.message },
    });
  }
};

/* ================= GET MY TECHNICIAN (FROM TOKEN) ================= */
export const getMyTechnician = async (req, res) => {
  try {
    const technicianProfileId = req.user?.technicianProfileId;

    if (!technicianProfileId || !isValidObjectId(technicianProfileId)) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
        result: {},
      });
    }

    const technician = await TechnicianProfile.findById(technicianProfileId)
      .populate("skills.serviceId", "serviceName")
      .populate({
        path: "userId",
        select: "fname lname mobileNumber email"
      })
      .select("-password");

    if (!technician) {
      return res.status(404).json({
        success: false,
        message: "Technician profile not found",
        result: {},
      });
    }

    return res.status(200).json({
      success: true,
      message: "Technician fetched successfully",
      result: technician,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Server error",
      result: { error: error.message },
    });
  }
};

/* ================= UPDATE TECHNICIAN ================= */
export const updateTechnician = async (req, res) => {
  try {
    const { skills, availability } = req.body;
    const technicianProfileId = req.user?.technicianProfileId;

    if (!technicianProfileId || !isValidObjectId(technicianProfileId)) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
        result: {},
      });
    }

    if (!validateSkills(skills)) {
      return res.status(400).json({
        success: false,
        message: "Invalid skills format",
        result: {},
      });
    }

    const technician = await TechnicianProfile.findById(technicianProfileId);
    if (!technician) {
      return res.status(404).json({
        success: false,
        message: "Technician not found",
        result: {},
      });
    }

    if (skills !== undefined) {
      technician.skills = skills;
    }

    if (availability?.isOnline !== undefined) {
      // 🔒 Check if training is completed
      if (!technician.trainingCompleted) {
        return res.status(403).json({
          success: false,
          message: "Training must be completed before going online. Contact admin to complete your training.",
          result: { trainingCompleted: false },
        });
      }

      // Check if technician is approved before allowing online status
      if (technician.workStatus !== "approved") {
        return res.status(403).json({
          success: false,
          message: "Only approved technicians can go online. Current status: " + technician.workStatus,
          result: { currentStatus: technician.workStatus },
        });
      }

      // Check if KYC is approved
      const kyc = await mongoose.model('TechnicianKyc').findOne({ technicianId: technicianProfileId });
      if (!kyc || kyc.verificationStatus !== "approved") {
        return res.status(403).json({
          success: false,
          message: "Your KYC must be approved by owner before going online",
          result: { kycStatus: kyc?.verificationStatus || "not_submitted" },
        });
      }

      const isGoingOnline = Boolean(availability.isOnline) && !technician.availability.isOnline;
      technician.availability.isOnline = Boolean(availability.isOnline);

      // 🔥 When technician goes online, broadcast existing unassigned jobs
      if (isGoingOnline && technician.skills.length > 0) {
        try {
          const technicianServiceIds = technician.skills
            .map(s => s.serviceId)
            .filter(Boolean)
            .map(id => new mongoose.Types.ObjectId(id));

          if (technicianServiceIds.length > 0) {
            // Find unassigned bookings matching technician's skills
            const unassignedBookings = await ServiceBooking.find({
              serviceId: { $in: technicianServiceIds },
              technicianId: null, // No technician assigned yet
              status: "broadcasted",
            }).select("_id serviceId");

            // Check which bookings this technician hasn't received yet
            const existingBroadcasts = await JobBroadcast.find({
              technicianId: technicianProfileId,
              bookingId: { $in: unassignedBookings.map(b => b._id) },
            }).select("bookingId");

            const existingBookingIds = new Set(
              existingBroadcasts.map(b => b.bookingId.toString())
            );

            // Create broadcasts for new jobs
            const newBroadcasts = unassignedBookings
              .filter(booking => !existingBookingIds.has(booking._id.toString()))
              .map(booking => ({
                bookingId: booking._id,
                technicianId: technicianProfileId,
                status: "sent",
              }));

            if (newBroadcasts.length > 0) {
              await JobBroadcast.insertMany(newBroadcasts);
              console.log(`✅ Broadcasted ${newBroadcasts.length} existing jobs to technician ${technicianProfileId}`);
            }
          }
        } catch (broadcastError) {
          console.error("⚠️ Error broadcasting existing jobs:", broadcastError.message);
          // Don't fail the online status update if broadcast fails
        }
      }
    }

    await technician.save();

    const result = technician.toObject();
    delete result.password;

    return res.status(200).json({
      success: true,
      message: "Technician updated successfully",
      result,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Server error",
      result: { error: error.message },
    });
  }
};

/* ================= UPDATE TECHNICIAN STATUS (ADMIN) ================= */
export const updateTechnicianStatus = async (req, res) => {
  try {
    const { technicianId, trainingCompleted, workStatus } = req.body;

    if (!isValidObjectId(technicianId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid Technician ID",
        result: {},
      });
    }

    if (req.user?.role !== "Owner") {
      return res.status(403).json({
        success: false,
        message: "Owner access only",
      });
    }

    const technician = await TechnicianProfile.findById(technicianId);
    if (!technician) {
      return res.status(404).json({
        success: false,
        message: "Technician not found",
        result: {},
      });
    }

    if (trainingCompleted !== undefined) {
      technician.trainingCompleted = Boolean(trainingCompleted);
      if (trainingCompleted === true) {
        technician.workStatus = "trained";
      }
    }

    if (workStatus !== undefined) {
      if (!TECHNICIAN_STATUSES.includes(workStatus)) {
        return res.status(400).json({
          success: false,
          message: "Invalid workStatus value. Must be: pending, trained, approved, or suspended",
          result: {},
        });
      }

      technician.workStatus = workStatus;

      if (workStatus === "suspended") {
        technician.availability.isOnline = false;
      }
    }

    await technician.save();

    const result = technician.toObject();
    delete result.password;

    return res.status(200).json({
      success: true,
      message: "Technician status updated successfully",
      result,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Server error",
      result: { error: error.message },
    });
  }
};

/* ================= DELETE TECHNICIAN ================= */
export const deleteTechnician = async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid Technician ID",
        result: {},
      });
    }

    const technician = await TechnicianProfile.findById(id);
    if (!technician) {
      return res.status(404).json({
        success: false,
        message: "Technician not found",
        result: {},
      });
    }

    const technicianProfileId = req.user?.technicianProfileId;
    const isOwner = req.user?.role === "Owner";
    if (!isOwner && (!technicianProfileId || technician._id.toString() !== technicianProfileId.toString())) {
      return res.status(403).json({
        success: false,
        message: "Access denied",
      });
    }

    await technician.deleteOne();

    return res.status(200).json({
      success: true,
      message: "Technician deleted successfully",
      result: {},
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Server error",
      result: { error: error.message },
    });
  }
};

/* ================= UPDATE TECHNICIAN TRAINING STATUS (OWNER ONLY) ================= */
export const updateTechnicianTraining = async (req, res) => {
  try {
    const { technicianId } = req.params;
    const { trainingCompleted } = req.body;

    // 🛡️ Owner access only
    if (req.user?.role !== "Owner") {
      return res.status(403).json({
        success: false,
        message: "Owner access only",
        result: {},
      });
    }

    if (!isValidObjectId(technicianId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid Technician ID",
        result: {},
      });
    }

    if (typeof trainingCompleted !== "boolean") {
      return res.status(400).json({
        success: false,
        message: "trainingCompleted must be a boolean value",
        result: {},
      });
    }

    const technician = await TechnicianProfile.findById(technicianId).select("-password");

    if (!technician) {
      return res.status(404).json({
        success: false,
        message: "Technician not found",
        result: {},
      });
    }

    // Update training status
    technician.trainingCompleted = trainingCompleted;

    // If training is being set to false, force offline
    if (!trainingCompleted && technician.availability?.isOnline) {
      technician.availability.isOnline = false;
      console.log(`⚠️ Technician ${technicianId} forced offline due to incomplete training`);
    }

    await technician.save();

    return res.status(200).json({
      success: true,
      message: `Training status updated to ${trainingCompleted ? 'completed' : 'incomplete'}`,
      result: {
        technicianId: technician._id,
        trainingCompleted: technician.trainingCompleted,
        workStatus: technician.workStatus,
        isOnline: technician.availability?.isOnline || false,
      },
    });
  } catch (error) {
    console.error("Update training error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error",
      result: { error: error.message },
    });
  }
};
/* ================= UPLOAD TECHNICIAN PROFILE IMAGE ================= */
export const uploadProfileImage = async (req, res) => {
  try {
    const technicianProfileId = req.user?.technicianProfileId;

    if (!technicianProfileId) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
        result: {},
      });
    }

    if (req.user?.role !== "Technician") {
      return res.status(403).json({
        success: false,
        message: "Only technicians can upload profile image",
        result: {},
      });
    }

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "No image file provided",
        result: {},
      });
    }

    const technician = await TechnicianProfile.findByIdAndUpdate(
      technicianProfileId,
      { profileImage: req.file.path },
      { new: true, runValidators: true }
    ).select("-password");

    if (!technician) {
      return res.status(404).json({
        success: false,
        message: "Technician profile not found",
        result: {},
      });
    }

    return res.status(200).json({
      success: true,
      message: "Profile image uploaded successfully",
      result: {
        profileImage: technician.profileImage,
      },
    });
  } catch (error) {
    console.error("Upload profile image error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error",
      result: { error: error.message },
    });
  }
};
