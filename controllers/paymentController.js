import crypto from "node:crypto";
import https from "node:https";
import mongoose from "mongoose";

import Payment from "../Schemas/Payment.js";
import PaymentEvent from "../Schemas/PaymentEvent.js";
import ServiceBooking from "../Schemas/ServiceBooking.js";
import Service from "../Schemas/Service.js";
import { settleBookingEarningsIfEligible } from "../Utils/settlement.js";

/* ================= HELPERS ================= */

const ok = (res, status, message, result = {}) =>
  res.status(status).json({ success: true, message, result });

const fail = (res, status, message, result = {}) =>
  res.status(status).json({ success: false, message, result });

// ... existing code ...


export const retryPaymentSettlement = async (req, res) => {
  try {
    // Only Admin or Owner can force retry
    if (!["Admin", "Owner"].includes(req.user?.role)) {
      return fail(res, 403, "Admin/Owner access only", {});
    }

    const { bookingId } = req.body;
    if (!bookingId || !mongoose.Types.ObjectId.isValid(bookingId)) {
      return fail(res, 400, "Valid bookingId is required", {});
    }

    const { settled, reason } = await settleBookingEarningsIfEligible(bookingId);

    if (settled) {
      return ok(res, 200, "Settlement successful", { reason });
    } else {
      return fail(res, 400, "Settlement not applicable or failed", { reason });
    }

  } catch (error) {
    return fail(res, 500, error.message, { error: error?.message });
  }
};


const toMoney = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const round2 = (n) =>
  Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/* ================= RAZORPAY REQUEST ================= */

const razorpayRequest = async ({ method, path, body }) => {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;

  // 🔍 DEBUG (TEMPORARY)
  console.log("RAZORPAY_KEY_ID:", keyId);
  console.log(
    "RAZORPAY_KEY_SECRET:",
    keySecret ? keySecret.slice(0, 6) + "****" : undefined
  );

  if (!keyId || !keySecret) {
    const err = new Error("Razorpay keys not configured");
    err.statusCode = 500;
    throw err;
  }

  const payload = body ? JSON.stringify(body) : "";

  const options = {
    hostname: "api.razorpay.com",
    path,
    method,
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
      Authorization:
        "Basic " +
        Buffer.from(`${keyId}:${keySecret}`).toString("base64"),
    },
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (resp) => {
      let data = "";
      resp.on("data", (c) => (data += c));
      resp.on("end", () => {
        const json = data ? JSON.parse(data) : {};
        if (resp.statusCode >= 200 && resp.statusCode < 300) {
          return resolve(json);
        }
        const err = new Error(
          json?.error?.description || "Razorpay request failed"
        );
        err.statusCode = resp.statusCode;
        err.details = json;
        reject(err);
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
};

/* ================= COMMISSION SPLIT ================= */

const computeSplitFromService = ({ service, payableAmount }) => {
  const totalAmount = round2(payableAmount);
  //sk
  const pct = 10; // Fixed 10% commission
  const commissionAmount = round2((totalAmount * pct) / 100);
  const technicianAmount = round2(totalAmount - commissionAmount);

  return {
    commissionPercentage: pct,
    totalAmount,
    commissionAmount,
    technicianAmount,
  };
};

/* =====================================================
   1️⃣ CREATE PAYME// NT ORDER
===================================================== */

export const createPaymentOrder = async (req, res) => {
  try {
    if (req.user?.role !== "Customer") {
      return fail(res, 403, "Customer access only");
    }

    const { bookingId } = req.body;
    if (!mongoose.Types.ObjectId.isValid(bookingId)) {
      return fail(res, 400, "Valid bookingId required");
    }

    const booking = await ServiceBooking.findById(bookingId);
    if (!booking) return fail(res, 404, "Booking not found");

    if (
      //sk
      booking.customerId.toString() !==
      req.user?.userId?.toString()
    ) {
      return fail(res, 403, "Access denied");
    }

    if (booking.paymentStatus === "paid") {
      return ok(res, 200, "Already paid", {
        orderId: booking.paymentOrderId,
      });
    }

    const allowed = [
      // sk
      "requested",
      "broadcasted",
      "accepted",
      "on_the_way",
      "reached",
      "in_progress",
      "completed",
    ];
    if (!allowed.includes(booking.status)) {
      return fail(
        res,
        400,
        `Payment not allowed in status ${booking.status}`
      );
    }

    const service = await Service.findById(booking.serviceId);
    if (!service) return fail(res, 404, "Service not found");

    const payableAmount = toMoney(booking.baseAmount);
    if (payableAmount == null || payableAmount < 0) {
      return fail(res, 400, "Invalid amount");
    }

    const split = computeSplitFromService({
      service,
      payableAmount,
    });

    let payment = await Payment.findOne({ bookingId });
    if (!payment) {
      payment = await Payment.create({
        bookingId,
        baseAmount: split.totalAmount,
        totalAmount: split.totalAmount,
        commissionAmount: split.commissionAmount,
        technicianAmount: split.technicianAmount,
        provider: "razorpay",
        paymentMode: "online",
        currency: "INR",
      });
    }

    if (!payment.providerOrderId) {
      const order = await razorpayRequest({
        method: "POST",
        path: "/v1/orders",
        body: {
          amount: Math.round(split.totalAmount * 100),
          currency: "INR",
          receipt: `booking_${bookingId}`,
          payment_capture: 1,
        },
      });

      payment.providerOrderId = order.id;
      await payment.save();

      booking.paymentOrderId = order.id;
      booking.paymentProvider = "razorpay";
      booking.paymentId = payment._id;
      booking.commissionPercentage = split.commissionPercentage;
      booking.commissionAmount = split.commissionAmount;
      booking.technicianAmount = split.technicianAmount;
      await booking.save();
    }

    return ok(res, 201, "Payment order created", {
      keyId: process.env.RAZORPAY_KEY_ID,
      orderId: payment.providerOrderId,
      amount: payment.totalAmount,
      currency: payment.currency,
    });
  } catch (err) {
    return fail(res, err.statusCode || 500, err.message, err.details);
  }
};

/* =====================================================
   2️⃣ VERIFY PAYMENT
===================================================== */

export const verifyPayment = async (req, res) => {
  try {
    if (req.user?.role !== "Customer") {
      return fail(res, 403, "Customer access only");
    }

    const {
      bookingId,
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
    } = req.body;

    if (
      !bookingId ||
      !razorpay_order_id ||
      !razorpay_payment_id ||
      !razorpay_signature
    ) {
      return fail(res, 400, "Missing payment details");
    }

    const payment = await Payment.findOne({ bookingId });
    if (!payment) return fail(res, 404, "Payment not found");

    if (payment.providerOrderId !== razorpay_order_id) {
      return fail(res, 400, "Order mismatch");
    }

    const expected = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    if (expected !== razorpay_signature) {
      payment.status = "failed";
      payment.failureReason = "Invalid signature";
      await payment.save();
      return fail(res, 400, "Verification failed");
    }

    const session = await mongoose.startSession();
    await session.withTransaction(async () => {
      payment.status = "success";
      payment.providerPaymentId = razorpay_payment_id;
      payment.providerSignature = razorpay_signature;
      payment.verifiedAt = new Date();
      await payment.save({ session });

      await ServiceBooking.updateOne(
        { _id: bookingId },
        {
          $set: {
            paymentStatus: "paid",
            paidAmount: payment.totalAmount,
            paymentProviderPaymentId: razorpay_payment_id,
          },
        },
        { session }
      );
    });
    session.endSession();

    await settleBookingEarningsIfEligible(bookingId);

    return ok(res, 200, "Payment verified successfully");
  } catch (err) {
    return fail(res, 500, err.message);
  }
};

/* =====================================================
   3️⃣ WEBHOOK (AUDIT ONLY)
===================================================== */

export const razorpayWebhook = async (req, res) => {
  try {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    const signature = req.headers["x-razorpay-signature"];

    const expected = crypto
      .createHmac("sha256", secret)
      .update(req.rawBody)
      .digest("hex");

    if (expected !== signature) {
      return fail(res, 400, "Invalid webhook signature");
    }

    const event = req.body;

    const exists = await PaymentEvent.findOne({ eventId: event.id });
    if (exists) return ok(res, 200, "Already processed");

    await PaymentEvent.create({
      provider: "razorpay",
      eventId: event.id,
      eventType: event.event,
      payload: event,
    });

    return ok(res, 200, "Webhook received");
  } catch (err) {
    return fail(res, 500, err.message);
  }
};

export const updatePaymentStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, failureReason } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid payment ID",
      });
    }

    if (!["pending", "success", "failed"].includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Invalid status",
      });
    }

    const payment = await Payment.findByIdAndUpdate(
      id,
      {
        status,
        ...(status === "failed"
          ? { failureReason: failureReason || "manual" }
          : {}),
      },
      { new: true }
    );

    if (!payment) {
      return res.status(404).json({
        success: false,
        message: "Payment not found",
      });
    }

    if (status === "success") {
      await ServiceBooking.updateOne(
        { _id: payment.bookingId },
        { paymentStatus: "paid" }
      );
      await settleBookingEarningsIfEligible(payment.bookingId);
    }

    res.json({
      success: true,
      message: "Payment status updated",
      result: payment,
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};
