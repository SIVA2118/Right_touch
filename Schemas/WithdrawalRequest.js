import mongoose from "mongoose";

const withdrawalRequestSchema = new mongoose.Schema(
  {
    technicianId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "TechnicianProfile",
      required: true,
      index: true,
    },

    amount: {
      type: Number,
      required: true,
      min: 1,
    },
    

    status: {
      type: String,
      enum: ["requested", "approved", "rejected", "paid", "cancelled"],
      default: "requested",
      index: true,
    },

    requestedAt: {
      type: Date,
      default: Date.now,
    },

    decidedAt: {
      type: Date,
      default: null,
    },

    decidedBy: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
      index: true,
    },

    decisionNote: {
      type: String,
      default: null,
      trim: true,
    },

    payoutProvider: {
      type: String,
      default: null,
      trim: true,
    },

    payoutReference: {
      type: String,
      default: null,
      trim: true,
      index: true,
    },

    walletTransactionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "WalletTransaction",
      default: null,
      index: true,
    },
  },
  { timestamps: true }
);

withdrawalRequestSchema.index(
  { technicianId: 1, status: 1, createdAt: -1 },
  { name: "tech_withdrawals" }
);

export default mongoose.models.WithdrawalRequest ||
  mongoose.model("WithdrawalRequest", withdrawalRequestSchema);
