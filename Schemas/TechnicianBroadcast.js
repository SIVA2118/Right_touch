// Schemas/JobBroadcast.js
import mongoose from "mongoose";

const jobBroadcastSchema = new mongoose.Schema(
  {
    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ServiceBooking",
      required: true,
      index: true,
    },

    technicianId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "TechnicianProfile",
      required: true,
      index: true,
    },

    
    sentAt: {
      type: Date,
      default: Date.now,
    },

    status: {
      type: String,
      enum: ["sent", "accepted", "rejected", "expired"],
      default: "sent",
      index: true,
    },
  },
  { timestamps: true }
);



// 🚨 Prevent duplicate job sends
jobBroadcastSchema.index({ bookingId: 1, technicianId: 1 }, { unique: true });
// Index for sentAt (for querying/cleanup/analytics)
jobBroadcastSchema.index({ sentAt: 1 });

export default mongoose.models.JobBroadcast || mongoose.model("JobBroadcast", jobBroadcastSchema);
