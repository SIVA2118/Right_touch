import mongoose from "mongoose";

const ProductBookingSchema = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },

    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    

    // 📍 LOCATION FOR DELIVERY
    locationType: {
      type: String,
      enum: ["GPS", "ADDRESS"],
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

    location: {
      type: {
        type: String,
        enum: ["Point"],
        default: "Point",
      },
      coordinates: {
        type: [Number], // [longitude, latitude]
        index: "2dsphere",
      },
    },

    quantity: {
      type: Number,
      default: 1,
      min: 1,
    },

    paymentStatus: {
      type: String,
      enum: ["pending", "paid", "refunded", "completed"],
      default: "pending",
    },

    status: {
      type: String,
      enum: ["active", "completed", "cancelled"],
      default: "active",
    },
  },
  { timestamps: true }
);

export default mongoose.models.ProductBooking || mongoose.model("ProductBooking", ProductBookingSchema);
