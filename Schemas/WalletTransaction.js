import mongoose from "mongoose";

const walletTransactionSchema = new mongoose.Schema(
  {
    technicianId: { type: mongoose.Schema.Types.ObjectId, ref: "TechnicianProfile" },
    bookingId: { type: mongoose.Schema.Types.ObjectId, ref: "ServiceBooking" },
    paymentId: { type: mongoose.Schema.Types.ObjectId, ref: "Payment" },
    amount: { type: Number, required: true },
    type: {
      type: String,
      enum: ["credit", "debit"],
      required: true
    },
    source: { type: String, enum: ["job", "withdraw", "adjustment", "bonus"] },
    note: { type: String, trim: true },
    reason: { type: String, trim: true } // Backward compatibility
  },
  { timestamps: true }
);


export default mongoose.models.WalletTransaction || mongoose.model("WalletTransaction", walletTransactionSchema);
