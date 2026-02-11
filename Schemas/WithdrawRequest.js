import mongoose from "mongoose";

const withdrawRequestSchema = new mongoose.Schema(
  {
    technicianId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "TechnicianProfile",
      required: true,
      index: true
    },

    amount: {
      type: Number,
      required: true,
      min: 1
    },

    status: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
      index: true
    },

    approvedAt: {
      type: Date,
      default: null
    },

    rejectedAt: {
      type: Date,
      default: null
    },

    adminNote: {
      type: String,
      default: null
    }
  },
  { timestamps: true }
);

// Prevent duplicate pending requests (optional but good)
withdrawRequestSchema.index(
  { technicianId: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: "pending" } }
);

export default mongoose.model("WithdrawRequest", withdrawRequestSchema);
