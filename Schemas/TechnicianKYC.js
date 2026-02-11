import mongoose from "mongoose";
import crypto from "crypto";

const technicianKycSchema = new mongoose.Schema(
  {
    technicianId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "TechnicianProfile",
      required: true,
      unique: true,
      index: true,
    },

    /* ==========================
       📋 KYC DOCUMENTS
    ========================== */
    aadhaarNumber: {
      type: String,
      trim: true,
      validate: [
        /^\d{12}$/,
        "Aadhaar must be exactly 12 digits",
      ],
    },
    

    panNumber: {
      type: String,
      trim: true,
      uppercase: true,
      validate: [
        /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/,
        "Invalid PAN format",
      ],
    },

    drivingLicenseNumber: {
      type: String,
      trim: true,
      uppercase: true,
      validate: [
        {
          validator: function (v) {
            return v && v.length >= 10;
          },
          message: "Driving License must be at least 10 characters",
        },
      ],
    },

    documents: {
      aadhaarUrl: String,
      panUrl: String,
      dlUrl: String,
    },

    kycVerified: {
      type: Boolean,
      default: false,
    },

    verificationStatus: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
      index: true,
    },

    rejectionReason: {
      type: String,
      trim: true,
    },

    verifiedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User", // admin
    },

    verifiedAt: {
      type: Date,
    },

    /* ==========================
       💳 BANK & SALARY PAYOUT DETAILS
    ========================== */
    bankDetails: {
      accountHolderName: {
        type: String,
        trim: true,
        validate: [
          {
            validator: function (v) {
              return !v || /^[a-zA-Z\s]{3,}$/.test(v);
            },
            message: "Account holder name must be 3+ characters, alphabets and spaces only",
          },
        ],
      },

      bankName: {
        type: String,
        trim: true,
        validate: [
          {
            validator: function (v) {
              return !v || /^[a-zA-Z\s]{3,}$/.test(v);
            },
            message: "Bank name must be 3+ characters, alphabets and spaces only",
          },
        ],
      },

      // 🔐 Encrypted account number (stored encrypted, decrypted on retrieval)
      accountNumber: {
        type: String,
        trim: true,
        validate: [
          {
            validator: function (v) {
              return !v || /^\d{9,18}$/.test(v);
            },
            message: "Account number must be 9-18 digits",
          },
        ],
        select: false, // Don't return by default (sensitive data)
        sparse: true,
      },

      // Hash of plaintext account number for uniqueness checks
      accountNumberHash: {
        type: String,
        select: false,
        sparse: true,
      },

      ifscCode: {
        type: String,
        trim: true,
        uppercase: true,
        validate: [
          {
            validator: function (v) {
              return !v || /^[A-Z]{4}0[A-Z0-9]{6}$/.test(v);
            },
            message: "Invalid IFSC code format. Must be: 4 uppercase letters + 0 + 6 alphanumeric characters",
          },
        ],
      },

      branchName: {
        type: String,
        trim: true,
        validate: [
          {
            validator: function (v) {
              return !v || v.length >= 3;
            },
            message: "Branch name must be at least 3 characters",
          },
        ],
      },

      upiId: {
        type: String,
        trim: true,
        lowercase: true,
        validate: [
          {
            validator: function (v) {
              return !v || /^[a-zA-Z0-9._-]{2,}@[a-zA-Z]{2,}$/.test(v);
            },
            message: "Invalid UPI ID format. Example: user@bank",
          },
        ],
      },
    },

    bankVerified: {
      type: Boolean,
      default: false,
    },

    // When owner/admin requests technician to update incorrect bank details
    bankUpdateRequired: {
      type: Boolean,
      default: false,
    },

    bankVerificationStatus: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
    },

    bankRejectionReason: {
      type: String,
      trim: true,
    },

    bankVerifiedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User", // admin
    },

    bankVerifiedAt: {
      type: Date,
    },

    bankEditableUntil: {
      type: Date, // After verification, this is set to null
    },
  },
  { timestamps: true }
);

// 🔐 Unique index for account number hash (plaintext hashed)
// Guard against accidental double-registration (can happen if module is evaluated twice).
const hasAccountHashIndex = technicianKycSchema
  .indexes()
  .some(([fields]) => fields && fields["bankDetails.accountNumberHash"] === 1);

if (!hasAccountHashIndex) {
  technicianKycSchema.index(
    { "bankDetails.accountNumberHash": 1 },
    { unique: true, sparse: true }
  );
}

/* ==========================
   🔐 ENCRYPTION / DECRYPTION HELPERS
========================== */
const ENCRYPTION_KEY = process.env.ACCOUNT_ENCRYPTION_KEY || "default-key-change-in-production";
const ALGORITHM = "aes-256-cbc";

function encrypt(text) {
  if (!text) return null;
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, Buffer.from(ENCRYPTION_KEY.padEnd(32, "0").slice(0, 32)), iv);
  let encrypted = cipher.update(text);
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  return iv.toString("hex") + ":" + encrypted.toString("hex");
}

function decrypt(encryptedText) {
  if (!encryptedText) return null;
  const parts = encryptedText.split(":");
  const iv = Buffer.from(parts[0], "hex");
  const decipher = crypto.createDecipheriv(ALGORITHM, Buffer.from(ENCRYPTION_KEY.padEnd(32, "0").slice(0, 32)), iv);
  let decrypted = decipher.update(Buffer.from(parts[1], "hex"));
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  return decrypted.toString();
}

// Auto-hash and encrypt on save
technicianKycSchema.pre("save", function (next) {
  if (this.bankDetails?.accountNumber && !this.bankDetails.accountNumber.includes(":")) {
    const plaintext = this.bankDetails.accountNumber;
    // store hash for uniqueness
    this.bankDetails.accountNumberHash = crypto
      .createHash("sha256")
      .update(plaintext)
      .digest("hex");
    // encrypt and store ciphertext
    this.bankDetails.accountNumber = encrypt(plaintext);
  }
  next();
});

// Auto-decrypt on toJSON
technicianKycSchema.methods.toJSON = function () {
  const obj = this.toObject();
  if (obj.bankDetails?.accountNumber && obj.bankDetails.accountNumber.includes(":")) {
    obj.bankDetails.accountNumber = decrypt(obj.bankDetails.accountNumber);
  }
  return obj;
};

export default mongoose.models.TechnicianKyc || mongoose.model("TechnicianKyc", technicianKycSchema);
