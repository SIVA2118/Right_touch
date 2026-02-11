import mongoose from "mongoose";

const reportSchema = new mongoose.Schema(
  {
    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },

    bookingType: {
      type: String,
      enum: ["product", "service"],
      required: true,
    },

    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
    },

    
    serviceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Service",
    },

    technicianId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Technician",
    },

    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    complaint: {
      type: String,
      required: true,
    },

    image: String,

    status: {
      type: String,
      enum: ["open", "resolved"],
      default: "open",
    },
  },
  { timestamps: true }
);

export default mongoose.models.Report || mongoose.model("Report", reportSchema);
