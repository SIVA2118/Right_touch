import mongoose from "mongoose";

const geoPointSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ["Point"],
      default: "Point",
      required: true,
    },
    coordinates: {
      type: [Number],
      required: true,
      validate: {
        validator: function (v) {
          return (
            Array.isArray(v) &&
            v.length === 2 &&
            typeof v[0] === "number" &&
            Number.isFinite(v[0]) &&
            typeof v[1] === "number" &&
            Number.isFinite(v[1])
          );
        },
        
        message: "location.coordinates must be [longitude, latitude]",
      },
    },
  },
  { _id: false }
);

const technicianProfileSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
      index: true,
    },

    // Profile image (optional, not in User)
    profileImage: {
      type: String,
      trim: true,
    },

    // Geo location for technician matching
    location: {
      type: geoPointSchema,
      default: null,
    },

    /* ==========================
       🛠 WORK DETAILS
    ========================== */
    locality: {
      type: String,
      trim: true, // service area / working locality
    },

    experienceYears: {
      type: Number,
      default: 0,
      min: 0,
    },

    specialization: {
      type: String,
      trim: true,
    },

    certifications: [
      {
        name: { type: String, trim: true },
        issuer: { type: String, trim: true },
        expiryDate: Date,
      },
    ],

    /* ==========================
       🔧 TECHNICIAN OPERATIONAL DATA
    ========================== */

    skills: [
      {
        serviceId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Service",
          required: true,
        },
        experienceYears: { type: Number, default: 0 },
      },
    ],

    trainingCompleted: {
      type: Boolean,
      default: false,
    },

    workStatus: {
      type: String,
      enum: ["pending", "trained", "approved", "suspended"],
      default: "pending",
    },

    availability: {
      isOnline: {
        type: Boolean,
        default: false,
      },
    },

    rating: {
      avg: { type: Number, default: 0 },
      count: { type: Number, default: 0 },
    },

    walletBalance: {
      type: Number,
      default: 0,
    },

    totalJobsCompleted: {
      type: Number,
      default: 0,
    },

    profileComplete: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

// 2dsphere index for geo queries (nearby technicians)
technicianProfileSchema.index({ location: "2dsphere" });

export default mongoose.models.TechnicianProfile ||
  mongoose.model("TechnicianProfile", technicianProfileSchema);
