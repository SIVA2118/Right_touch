import mongoose from "mongoose";

const paymentSchema = new mongoose.Schema(
  {
    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ServiceBooking",
      required: true,
      unique: true,
    },

    provider: {
      type: String,
      default: "razorpay",
    },
    

    currency: {
      type: String,
      default: "INR",
    },

    providerOrderId: String,
    providerPaymentId: String,
    providerSignature: String,

    baseAmount: Number,
    totalAmount: Number,
    commissionAmount: Number,
    technicianAmount: Number,

    status: {
      type: String,
      enum: ["pending", "success", "failed"],
      default: "pending",
    },

    failureReason: String,
    verifiedAt: Date,
  },
  { timestamps: true }
);

paymentSchema.index(
  { provider: 1, providerOrderId: 1 },
  { unique: true, partialFilterExpression: { providerOrderId: { $type: "string" } } }
);

paymentSchema.index(
  { provider: 1, providerPaymentId: 1 },
  { unique: true, partialFilterExpression: { providerPaymentId: { $type: "string" } } }
);

export default mongoose.models.Payment || mongoose.model("Payment", paymentSchema);
