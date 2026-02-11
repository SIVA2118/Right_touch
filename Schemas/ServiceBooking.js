import mongoose from "mongoose";

const geoPointSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ["Point"],
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

const serviceBookingSchema = new mongoose.Schema(
  {

    // 👤 CUSTOMER PROFILE
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    // 🛠 SERVICE
    serviceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Service",
      required: true,
      index: true,
    },

    // 👨‍🔧 TECHNICIAN (assigned after accept)
    technicianId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "TechnicianProfile",
      default: null,
      index: true,
    },

    // 💰 PRICE SNAPSHOT
    baseAmount: {
      type: Number,
      required: true,
      min: 0,
    },

    // 📍 ADDRESS SNAPSHOT
    locationType: {
      type: String,
      enum: ["saved", "gps"],
      required: true,
    },

    addressSnapshot: {
      addressLine: String,
      city: String,
      state: String,
      pincode: String,
      name: String,
      phone: String,
      latitude: Number,
      longitude: Number,
    },

    // 📍 ADDRESS (Legacy / Display String)
    address: {
      type: String,
      required: true,
      trim: true,
    },

    // 📍 ADDRESS REFERENCE (for customer details)
    addressId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Address",
      default: null,
      index: true,
    },

    // ⏰ SCHEDULE
    scheduledAt: {
      type: Date,
    },

    // 💳 PAYMENT
    paymentStatus: {
      type: String,
      enum: ["pending", "paid", "refunded"],
      default: "pending",
      index: true,
    },

    paymentProvider: {
      type: String,
      enum: ["razorpay"],
      default: "razorpay",
    },

    paymentOrderId: {
      type: String,
      default: null,
      index: true,
    },

    paymentProviderPaymentId: {
      type: String,
      default: null,
      index: true,
    },

    paidAmount: {
      type: Number,
      default: 0,
      min: 0,
    },

    commissionPercentage: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },

    commissionAmount: {
      type: Number,
      default: 0,
      min: 0,
    },

    technicianAmount: {
      type: Number,
      default: 0,
      min: 0,
    },

    paymentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Payment",
    },

    // ✅ Settlement to technician wallet (idempotent)
    settlementStatus: {
      type: String,
      enum: ["pending", "eligible", "settled"],
      default: "pending",
      index: true,
    },

    settledAt: {
      type: Date,
      default: null,
    },

    // 📌 STATUS FLOW
    status: {
      type: String,
      enum: [
        "requested",
        "broadcasted",
        "accepted",
        "on_the_way",
        "reached",
        "in_progress",
        "completed",
        "cancelled",
      ],
      default: "requested",
      index: true,
    },

    assignedAt: {
      type: Date,
      default: null,
      index: true,
    },

    // Optional GeoJSON point for nearby matching
    location: {
      type: geoPointSchema,
      default: null,
    },

    // Broadcasted timestamp for expiry/cleanup
    broadcastedAt: {
      type: Date,
      default: null,
      index: true,
    },

    // Search radius in meters (for technician matching)
    radius: {
      type: Number,
      default: 500,
      min: 0,
    },
  },
  { timestamps: true }
);

// Helpful index for technician dashboard
serviceBookingSchema.index({ technicianId: 1, status: 1 });

// 2dsphere index for geo queries (optional, but required when using $near for bookings)
serviceBookingSchema.index({ location: "2dsphere" });

export default mongoose.models.ServiceBooking || mongoose.model("ServiceBooking", serviceBookingSchema);
