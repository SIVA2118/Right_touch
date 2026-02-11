import mongoose from "mongoose";

import ServiceBooking from "../Schemas/ServiceBooking.js";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import WalletTransaction from "../Schemas/WalletTransaction.js"; // ✅ FIXED

const toMoney = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export const settleBookingEarningsIfEligible = async (bookingId) => {
  if (!mongoose.Types.ObjectId.isValid(bookingId)) {
    return { settled: false, reason: "invalid_bookingId" };
  }

  const booking = await ServiceBooking.findById(bookingId);
  if (!booking) return { settled: false, reason: "booking_not_found" };

  if (booking.settlementStatus === "settled") {
    return { settled: true, reason: "already_settled" };
  }

  const eligible =
    booking.paymentStatus === "paid" &&
    booking.status === "completed" &&
    booking.technicianId &&
    mongoose.Types.ObjectId.isValid(booking.technicianId);

  if (!eligible) {
    if (booking.paymentStatus === "paid" && booking.settlementStatus === "pending") {
      booking.settlementStatus = "eligible";
      await booking.save();
    }
    return { settled: false, reason: "not_eligible" };
  }

  const technicianAmount = toMoney(booking.technicianAmount);
  if (!technicianAmount || technicianAmount <= 0) {
    booking.settlementStatus = "eligible";
    await booking.save();
    return { settled: false, reason: "invalid_technician_amount" };
  }

  // 🔁 Fallback if Mongo transactions are not supported
  const doNonTransactional = async () => {
    try {
      await WalletTransaction.create({
        technicianId: booking.technicianId,
        bookingId: booking._id,
        paymentId: booking.paymentId || null,
        amount: technicianAmount,
        type: "credit",
        source: "job",
        note: "Job earning credited after verified payment",
      });
    } catch (e) {
      if (e?.code !== 11000) throw e; // duplicate = already credited
    }

    await TechnicianProfile.updateOne(
      { _id: booking.technicianId },
      { $inc: { walletBalance: technicianAmount } }
    );

    await ServiceBooking.updateOne(
      { _id: booking._id },
      { $set: { settlementStatus: "settled", settledAt: new Date() } }
    );

    return { settled: true, reason: "settled_non_transactional" };
  };

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const existing = await WalletTransaction.findOne(
        { bookingId: booking._id, type: "credit", source: "job" },
        null,
        { session }
      );

      if (existing) {
        await ServiceBooking.updateOne(
          { _id: booking._id },
          { $set: { settlementStatus: "settled", settledAt: new Date() } },
          { session }
        );
        return;
      }

      await WalletTransaction.create(
        [
          {
            technicianId: booking.technicianId,
            bookingId: booking._id,
            paymentId: booking.paymentId || null,
            amount: technicianAmount,
            type: "credit",
            source: "job",
            note: "Job earning credited after verified payment",
          },
        ],
        { session }
      );

      await TechnicianProfile.updateOne(
        { _id: booking.technicianId },
        { $inc: { walletBalance: technicianAmount } },
        { session }
      );

      await ServiceBooking.updateOne(
        { _id: booking._id },
        { $set: { settlementStatus: "settled", settledAt: new Date() } },
        { session }
      );
    });

    return { settled: true, reason: "settled_transactional" };
  } catch (e) {
    const msg = String(e?.message || "");
    if (
      msg.includes("replica set") ||
      msg.includes("Transaction") ||
      msg.includes("mongos")
    ) {
      return await doNonTransactional();
    }
    throw e;
  } finally {
    session.endSession();
  }
};

