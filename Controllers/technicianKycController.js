import mongoose from "mongoose";
import crypto from "crypto";
import TechnicianKyc from "../Schemas/TechnicianKYC.js";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import { getTechnicianJobEligibility } from "../Utils/technicianEligibility.js";

const isValidObjectId = mongoose.Types.ObjectId.isValid;

const isOwnerOrAdmin = (req) =>
  req.user?.role === "Owner" || req.user?.role === "Admin";


/* ================= VALIDATION HELPERS ================= */
const validateBankDetails = (bankDetails) => {
  if (!bankDetails) return { valid: true }; // Optional

  const errors = [];

  if (bankDetails.accountHolderName) {
    if (!/^[a-zA-Z\s]{3,}$/.test(bankDetails.accountHolderName)) {
      errors.push("Account holder name must be 3+ characters, alphabets and spaces only");
    }
  }

  if (bankDetails.bankName) {
    if (!/^[a-zA-Z\s]{3,}$/.test(bankDetails.bankName)) {
      errors.push("Bank name must be 3+ characters, alphabets and spaces only");
    }
  }

  if (bankDetails.accountNumber) {
    if (!/^\d{9,18}$/.test(bankDetails.accountNumber)) {
      errors.push("Account number must be 9-18 digits only");
    }
  }

  if (bankDetails.ifscCode) {
    if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(bankDetails.ifscCode.toUpperCase())) {
      errors.push("Invalid IFSC code format. Must be: 4 uppercase letters + 0 + 6 alphanumeric characters");
    }
  }

  if (bankDetails.branchName) {
    if (bankDetails.branchName.length < 3) {
      errors.push("Branch name must be at least 3 characters");
    }
  }

  if (bankDetails.upiId) {
    if (!/^[a-zA-Z0-9._-]{2,}@[a-zA-Z]{2,}$/.test(bankDetails.upiId)) {
      errors.push("Invalid UPI ID format. Example: username@bank");
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
};

const titleCase = (str) => {
  if (!str) return str;
  return str
    .toLowerCase()
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
};

/* ================= SUBMIT / UPDATE TECHNICIAN KYC & BANK DETAILS ================= */
export const submitTechnicianKyc = async (req, res) => {
  try {
    const {
      aadhaarNumber,
      panNumber,
      drivingLicenseNumber,
      bankDetails,
    } = req.body;
    const technicianProfileId = req.user?.technicianProfileId;

    if (!technicianProfileId) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
        result: {},
      });
    }

    // Enforce Technician role for KYC submission
    if (req.user?.role !== "Technician") {
      return res.status(403).json({
        success: false,
        message: "Technician access only",
        result: {},
      });
    }

    // Check if technician profile is complete
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
        message: "Please complete your profile first before submitting KYC",
        result: {},
      });
    }

    // Fetch existing KYC
    const existingKyc = await TechnicianKyc.findOne({
      technicianId: technicianProfileId,
    });

    // 🔒 Prevent editing bank details after verification
    if (
      existingKyc &&
      existingKyc.bankVerified &&
      bankDetails
    ) {
      return res.status(403).json({
        success: false,
        message: "Bank details cannot be edited after verification. Contact admin for changes.",
        result: { bankVerified: true },
      });
    }

    // Validate bank details if provided
    if (bankDetails) {
      const bankValidation = validateBankDetails(bankDetails);
      if (!bankValidation.valid) {
        return res.status(400).json({
          success: false,
          message: "Invalid bank details",
          result: { errors: bankValidation.errors },
        });
      }

      // 🔍 Check for duplicate account number (if updating bank details)
      if (bankDetails.accountNumber) {
        const accountNumberHash = crypto
          .createHash("sha256")
          .update(bankDetails.accountNumber)
          .digest("hex");

        const duplicateAccount = await TechnicianKyc.findOne({
          "bankDetails.accountNumberHash": accountNumberHash,
          technicianId: { $ne: technicianProfileId },
        });

        if (duplicateAccount) {
          return res.status(400).json({
            success: false,
            message: "Account number already registered with another technician",
            result: { field: "accountNumber" },
          });
        }
      }
    }

    // Prepare update object
    const updateData = {
      technicianId: technicianProfileId,
      aadhaarNumber,
      panNumber,
      drivingLicenseNumber,
      verificationStatus: "pending",
      rejectionReason: null,
    };

    // If bank details provided, reset verification status
    if (bankDetails) {
      const processedBankDetails = {
        accountHolderName: bankDetails.accountHolderName
          ? titleCase(bankDetails.accountHolderName.trim())
          : bankDetails.accountHolderName,
        bankName: bankDetails.bankName ? bankDetails.bankName.trim() : bankDetails.bankName,
        accountNumber: bankDetails.accountNumber ? bankDetails.accountNumber.trim() : bankDetails.accountNumber,
        accountNumberHash: bankDetails.accountNumber
          ? crypto.createHash("sha256").update(bankDetails.accountNumber.trim()).digest("hex")
          : undefined,
        ifscCode: bankDetails.ifscCode ? bankDetails.ifscCode.toUpperCase().trim() : bankDetails.ifscCode,
        branchName: bankDetails.branchName ? bankDetails.branchName.trim() : bankDetails.branchName,
        upiId: bankDetails.upiId ? bankDetails.upiId.toLowerCase().trim() : bankDetails.upiId,
      };

      updateData.bankDetails = processedBankDetails;
      updateData.bankVerificationStatus = "pending";
      updateData.bankRejectionReason = null;
      updateData.bankVerified = false;
      updateData.bankUpdateRequired = false;
      updateData.bankEditableUntil = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days grace period
    }

    const kyc = await TechnicianKyc.findOneAndUpdate(
      { technicianId: technicianProfileId },
      updateData,
      {
        new: true,
        upsert: true,
        runValidators: true,
      }
    );

    return res.status(201).json({
      success: true,
      message: "Technician KYC and bank details submitted successfully",
      result: {
        kycVerified: kyc.kycVerified,
        bankVerified: kyc.bankVerified,
      },
    });
  } catch (error) {
    console.error("submitTechnicianKyc error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Server error",
      result: { error: error.message },
    });
  }
};

/* ================= UPLOAD TECHNICIAN KYC DOCUMENTS (IMAGES) ================= */
export const uploadTechnicianKycDocuments = async (req, res) => {
  try {
    const authUserId = req.user?.userId;

    if (!authUserId) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
        result: {},
      });
    }

    if (!req.files || Object.keys(req.files).length === 0) {
      return res.status(400).json({
        success: false,
        message: "KYC documents are required",
        result: {},
      });
    }

    // Enforce Technician role for KYC documents upload
    if (req.user?.role !== "Technician") {
      return res.status(403).json({
        success: false,
        message: "Technician access only",
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

    const kyc = await TechnicianKyc.findOne({ technicianId: technicianProfileId });
    if (!kyc) {
      return res.status(404).json({
        success: false,
        message: "KYC record not found",
        result: {},
      });
    }

    if (req.files.aadhaarImage) {
      kyc.documents.aadhaarUrl = req.files.aadhaarImage[0].path;
    }

    if (req.files.panImage) {
      kyc.documents.panUrl = req.files.panImage[0].path;
    }

    if (req.files.dlImage) {
      kyc.documents.dlUrl = req.files.dlImage[0].path;
    }

    await kyc.save();

    return res.status(200).json({
      success: true,
      message: "KYC documents uploaded successfully",
      result: kyc,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Server error",
      result: { error: error.message },
    });
  }
};

/* ================= GET TECHNICIAN KYC (TECHNICIAN / ADMIN) ================= */
export const getAllTechnicianKyc = async (req, res) => {
  try {
    if (!isOwnerOrAdmin(req)) {
      return res.status(403).json({
        success: false,
        message: "Owner/Admin access only",
        result: {},
      });
    }

    // NOTE:
    // Some legacy/bad records may have `technicianId` missing/null OR referencing a deleted TechnicianProfile.
    // If we only use populate(), those become `technicianId: null` and it's impossible to debug in the client.
    // So we fetch lean docs, then attach a populated technician object when possible + expose technicianIdRaw.
    const kycDocs = await TechnicianKyc.find()
      .select('+bankDetails.accountNumber +bankDetails.accountNumberHash')
      .lean();

    const technicianIds = Array.from(
      new Set(
        kycDocs
          .map((k) => k.technicianId)
          .filter((id) => id && isValidObjectId(id))
          .map((id) => id.toString())
      )
    ).map((id) => new mongoose.Types.ObjectId(id));

    const technicians = technicianIds.length
      ? await TechnicianProfile.find({ _id: { $in: technicianIds } })
        .select("userId firstName lastName skills workStatus profileComplete availability")
        .lean()
      : [];

    const techById = new Map(technicians.map((t) => [t._id.toString(), t]));

    const kyc = kycDocs.map((k) => {
      const technicianIdRaw = k.technicianId ? k.technicianId.toString() : null;
      const technician = technicianIdRaw ? techById.get(technicianIdRaw) : null;

      return {
        ...k,
        technicianId: technician || null,
        technicianIdRaw,
        technicianIdMissing: technicianIdRaw === null,
        orphanedTechnician: technicianIdRaw !== null && !technician,
      };
    });

    return res.status(200).json({
      success: true,
      message: "KYC fetched successfully",
      result: kyc,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Server error",
      result: { error: error.message },
    });
  }
};

/* ================= GET TECHNICIAN KYC (TECHNICIAN / ADMIN) ================= */
export const getTechnicianKyc = async (req, res) => {
  try {
    const { technicianId } = req.params;

    if (!isValidObjectId(technicianId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid Technician ID",
        result: {},
      });
    }

    const kycDoc = await TechnicianKyc.findOne({ technicianId }).lean();

    if (!kycDoc) {
      return res.status(404).json({
        success: false,
        message: "KYC record not found",
        result: {},
      });
    }

    const isPrivileged = isOwnerOrAdmin(req);
    if (!isPrivileged) {
      const technicianProfileId = req.user?.technicianProfileId;
      if (!technicianProfileId || technicianProfileId.toString() !== technicianId) {
        return res.status(403).json({
          success: false,
          message: "Access denied",
          result: {},
        });
      }
    }

    const technician = await TechnicianProfile.findById(technicianId)
      .select("userId skills workStatus profileComplete availability")
      .populate({
        path: "userId",
        select: "fname lname mobileNumber email",
        options: { lean: true }
      })
      .lean();

    const kyc = {
      ...kycDoc,
      technicianId: technician ? {
        ...technician,
        _id: technician._id,
        firstName: technician?.userId?.fname || null,
        lastName: technician?.userId?.lname || null,
        mobileNumber: technician?.userId?.mobileNumber || null,
        email: technician?.userId?.email || null,
        userId: technician?.userId?._id || null
      } : null,
      technicianIdRaw: technicianId,
      technicianIdMissing: false,
      orphanedTechnician: !technician,
    };

    return res.status(200).json({
      success: true,
      message: "KYC fetched successfully",
      result: kyc,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Server error",
      result: { error: error.message },
    });
  }
};

/* ================= GET MY TECHNICIAN KYC (FROM TOKEN) ================= */
export const getMyTechnicianKyc = async (req, res) => {
  try {
    const technicianProfileId = req.user?.technicianProfileId;

    if (!technicianProfileId || !isValidObjectId(technicianProfileId)) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
        result: {},
      });
    }

    const kyc = await TechnicianKyc.findOne({ technicianId: technicianProfileId })
      .populate("technicianId", "firstName lastName skills workStatus profileComplete availability");
    if (!kyc) {
      return res.status(404).json({
        success: false,
        message: "KYC record not found",
        result: {},
      });
    }

    const eligibility = await getTechnicianJobEligibility({ technicianProfileId });

    return res.status(200).json({
      success: true,
      message: "KYC fetched successfully",
      result: {
        ...kyc.toObject(),
        eligibility,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Server error",
      result: { error: error.message },
    });
  }
};

/* ================= ADMIN VERIFY / REJECT TECHNICIAN KYC ================= */
export const verifyTechnicianKyc = async (req, res) => {
  try {
    const { technicianId, status, rejectionReason } = req.body;

    if (!isOwnerOrAdmin(req)) {
      return res.status(403).json({
        success: false,
        message: "Owner/Admin access only",
        result: {},
      });
    }

    if (!technicianId || !isValidObjectId(technicianId) || !status) {
      return res.status(400).json({
        success: false,
        message: "Technician ID and status are required",
        result: {},
      });
    }

    if (!["approved", "rejected"].includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Invalid verification status",
        result: {},
      });
    }

    if (status === "rejected" && !rejectionReason) {
      return res.status(400).json({
        success: false,
        message: "Rejection reason is required",
        result: {},
      });
    }

    const kyc = await TechnicianKyc.findOne({ technicianId });
    if (!kyc) {
      return res.status(404).json({
        success: false,
        message: "KYC record not found",
        result: {},
      });
    }

    kyc.verificationStatus = status;
    kyc.kycVerified = status === "approved";
    kyc.rejectionReason = status === "rejected" ? rejectionReason : null;
    kyc.verifiedAt = new Date();
    kyc.verifiedBy = req.user.userId;

    await kyc.save();

    if (status === "approved") {
      await TechnicianProfile.findByIdAndUpdate(technicianId, {
        workStatus: "approved",
        approvedAt: new Date(),
      });
    } else {
      await TechnicianProfile.findByIdAndUpdate(technicianId, {
        workStatus: "suspended",
        "availability.isOnline": false,
      });
    }

    return res.status(200).json({
      success: true,
      message: `KYC ${status} successfully`,
      result: kyc,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Server error",
      result: { error: error.message },
    });
  }
};

/* ================= ADMIN VERIFY / REJECT BANK DETAILS ================= */
export const verifyBankDetails = async (req, res) => {
  try {
    const { technicianId, verified, bankRejectionReason } = req.body;

    if (!isOwnerOrAdmin(req)) {
      return res.status(403).json({
        success: false,
        message: "Owner/Admin access only",
        result: {},
      });
    }

    if (!technicianId || !isValidObjectId(technicianId) || typeof verified !== "boolean") {
      return res.status(400).json({
        success: false,
        message: "Technician ID and 'verified' boolean are required",
        result: {},
      });
    }

    // If rejecting (verified: false) and bankRejectionReason provided, validate it
    if (!verified && bankRejectionReason && String(bankRejectionReason).trim().length < 5) {
      return res.status(400).json({
        success: false,
        message: "Rejection reason must be at least 5 characters",
        result: {},
      });
    }

    const kyc = await TechnicianKyc.findOne({ technicianId }).select('+bankDetails.accountNumber');
    if (!kyc) {
      return res.status(404).json({
        success: false,
        message: "KYC record not found",
        result: {},
      });
    }

    if (!kyc.bankDetails?.accountNumber) {
      return res.status(400).json({
        success: false,
        message: "No bank details found for this technician",
        result: {},
      });
    }

    // 🔒 Bank details can only be verified after training and KYC approval
    const technician = await TechnicianProfile.findById(technicianId).select("trainingCompleted");
    if (!technician || !technician.trainingCompleted) {
      return res.status(403).json({
        success: false,
        message: "Technician must complete training before bank verification",
        result: { trainingCompleted: false },
      });
    }

    // KYC may be mandatory; if not approved yet, don't allow bank verification
    if (!kyc.kycVerified) {
      return res.status(403).json({
        success: false,
        message: "KYC must be verified before bank details can be verified",
        result: { kycVerified: false },
      });
    }

    // Manual flow: either verify or request update (no reject state)
    if (verified) {
      kyc.bankVerified = true;
      kyc.bankUpdateRequired = false;
      kyc.bankVerifiedAt = new Date();
      kyc.bankVerifiedBy = req.user.userId;
      kyc.bankVerificationStatus = "approved";
      kyc.bankEditableUntil = null; // lock edits
      kyc.bankRejectionReason = null; // clear any previous reason
    } else {
      kyc.bankVerified = false;
      kyc.bankUpdateRequired = true;
      kyc.bankVerificationStatus = "pending";
      // Set rejection reason if provided
      if (bankRejectionReason) {
        kyc.bankRejectionReason = String(bankRejectionReason).trim();
      }
      // keep editable; optionally extend window
      if (!kyc.bankEditableUntil || kyc.bankEditableUntil < new Date()) {
        kyc.bankEditableUntil = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      }
    }

    // Skip validation since we're only updating flags, not the encrypted bank details
    await kyc.save({ validateModifiedOnly: true });

    if (verified) {
      return res.status(200).json({
        success: true,
        message: "Technician bank details verified successfully",
        data: { bankVerified: true },
      });
    }

    return res.status(200).json({
      success: true,
      message: "Bank details update requested from technician",
      data: {
        bankVerified: false,
        bankUpdateRequired: true,
        bankRejectionReason: kyc.bankRejectionReason || null
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Server error",
      result: { error: error.message },
    });
  }
};

/* ================= DELETE TECHNICIAN KYC ================= */
export const deleteTechnicianKyc = async (req, res) => {
  try {
    const { technicianId } = req.params;

    if (!isValidObjectId(technicianId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid Technician ID",
        result: {},
      });
    }

    if (!isOwnerOrAdmin(req)) {
      return res.status(403).json({
        success: false,
        message: "Owner/Admin access only",
        result: {},
      });
    }

    const kyc = await TechnicianKyc.findOneAndDelete({ technicianId });

    if (!kyc) {
      return res.status(404).json({
        success: false,
        message: "KYC record not found",
        result: {},
      });
    }

    await TechnicianProfile.findByIdAndUpdate(technicianId, {
      workStatus: "suspended",
      "availability.isOnline": false,
    });

    return res.status(200).json({
      success: true,
      message: "Technician KYC deleted successfully",
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

/* ================= GET ALL ORPHANED KYC RECORDS ================= */
export const getOrphanedKyc = async (req, res) => {
  try {
    if (!isOwnerOrAdmin(req)) {
      return res.status(403).json({
        success: false,
        message: "Owner/Admin access only",
        result: {},
      });
    }

    // Fetch all KYC records
    const allKyc = await TechnicianKyc.find().lean();

    // Get all technician IDs that exist
    const technicianIds = await TechnicianProfile.find().select("_id").lean();
    const existingTechIds = new Set(technicianIds.map((t) => t._id.toString()));

    // Find orphaned records
    const orphanedRecords = allKyc.filter((k) => {
      const techIdStr = k.technicianId ? k.technicianId.toString() : null;
      return techIdStr && !existingTechIds.has(techIdStr);
    });

    return res.status(200).json({
      success: true,
      message: `Found ${orphanedRecords.length} orphaned KYC records`,
      result: {
        count: orphanedRecords.length,
        records: orphanedRecords,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Server error",
      result: { error: error.message },
    });
  }
};

/* ================= DELETE ORPHANED KYC BY ID ================= */
export const deleteOrphanedKyc = async (req, res) => {
  try {
    const { kycId } = req.params;

    if (!isValidObjectId(kycId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid KYC ID",
        result: {},
      });
    }

    if (!isOwnerOrAdmin(req)) {
      return res.status(403).json({
        success: false,
        message: "Owner/Admin access only",
        result: {},
      });
    }

    const kyc = await TechnicianKyc.findById(kycId);
    if (!kyc) {
      return res.status(404).json({
        success: false,
        message: "KYC record not found",
        result: {},
      });
    }

    // Verify it's actually orphaned
    if (kyc.technicianId) {
      const technician = await TechnicianProfile.findById(kyc.technicianId);
      if (technician) {
        return res.status(400).json({
          success: false,
          message: "KYC record is not orphaned. This technician exists.",
          result: { technicianId: kyc.technicianId },
        });
      }
    }

    // Delete orphaned KYC
    await TechnicianKyc.findByIdAndDelete(kycId);

    return res.status(200).json({
      success: true,
      message: "Orphaned KYC record deleted successfully",
      result: { kycId },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Server error",
      result: { error: error.message },
    });
  }
};

/* ================= DELETE ALL ORPHANED KYC RECORDS ================= */
export const deleteAllOrphanedKyc = async (req, res) => {
  try {
    if (!isOwnerOrAdmin(req)) {
      return res.status(403).json({
        success: false,
        message: "Owner/Admin access only",
        result: {},
      });
    }

    // Fetch all KYC records
    const allKyc = await TechnicianKyc.find().lean();

    // Get all technician IDs that exist
    const technicianIds = await TechnicianProfile.find().select("_id").lean();
    const existingTechIds = new Set(technicianIds.map((t) => t._id.toString()));

    // Find orphaned records
    const orphanedIds = allKyc
      .filter((k) => {
        const techIdStr = k.technicianId ? k.technicianId.toString() : null;
        return techIdStr && !existingTechIds.has(techIdStr);
      })
      .map((k) => k._id);

    if (orphanedIds.length === 0) {
      return res.status(200).json({
        success: true,
        message: "No orphaned KYC records found",
        result: { deletedCount: 0 },
      });
    }

    // Delete all orphaned records
    const deleteResult = await TechnicianKyc.deleteMany({
      _id: { $in: orphanedIds },
    });

    return res.status(200).json({
      success: true,
      message: `Deleted ${deleteResult.deletedCount} orphaned KYC records`,
      result: { deletedCount: deleteResult.deletedCount, recordIds: orphanedIds },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Server error",
      result: { error: error.message },
    });
  }
};
