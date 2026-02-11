import mongoose from "mongoose";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import WalletTransaction from "../Schemas/WalletTransaction.js";
import WithdrawRequest from "../Schemas/WithdrawRequest.js";
import ServiceBooking from "../Schemas/ServiceBooking.js";

const isValidObjectId = mongoose.Types.ObjectId.isValid;

const toMoney = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const getConfig = () => {
  const minWithdrawal = toMoney(process.env.MIN_WITHDRAWAL_AMOUNT) ?? 500;
  const cooldownDays = toMoney(process.env.WITHDRAWAL_COOLDOWN_DAYS) ?? 7;
  return {
    minWithdrawal,
    cooldownMs: Math.max(0, cooldownDays) * 24 * 60 * 60 * 1000,
  };
};


// Add Wallet Transaction (Owner only)
export const createWalletTransaction = async (req, res) => {
  try {
    const { technicianId, bookingId, amount, type, source } = req.body;

    if (req.user?.role !== "Owner") {
      return res.status(403).json({
        success: false,
        message: "Owner access only",
        result: {},
      });
    }

    if (!technicianId || !isValidObjectId(technicianId)) {
      return res.status(400).json({
        success: false,
        message: "Valid technicianId is required",
        result: {},
      });
    }

    if (bookingId && !isValidObjectId(bookingId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid bookingId",
        result: {},
      });
    }

    if (amount === undefined || Number.isNaN(Number(amount))) {
      return res.status(400).json({
        success: false,
        message: "Amount must be numeric",
        result: {},
      });
    }

    if (Number(amount) <= 0) {
      return res.status(400).json({
        success: false,
        message: "Amount must be positive",
        result: {},
      });
    }

    if (!["credit", "debit"].includes(type)) {
      return res.status(400).json({
        success: false,
        message: "Invalid transaction type",
        result: {},
      });
    }

    if (!["job", "penalty"].includes(source)) {
      return res.status(400).json({
        success: false,
        message: "Invalid transaction source",
        result: {},
      });
    }

    const technician = await TechnicianProfile.findById(technicianId);
    if (!technician) {
      return res.status(404).json({
        success: false,
        message: "Technician not found",
        result: {},
      });
    }

    if (bookingId) {
      const booking = await ServiceBooking.findOne({ _id: bookingId, technicianId });
      if (!booking) {
        return res.status(404).json({
          success: false,
          message: "Booking not found for technician",
          result: {},
        });
      }
    }

    const transaction = await WalletTransaction.create({
      technicianId,
      bookingId,
      amount: Number(amount),
      type,
      source,
    });

    res.status(201).json({
      success: true,
      message: "Wallet transaction recorded",
      result: transaction,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message, result: { error: error.message } });
  }
};

/* GET WALLET BALANCE */
export const getTechnicianWallet = async (req, res) => {
  try {
    // ensureTechnician(req); // Handled by middleware //sk

    const tech = req.technician;
    //sk
    const techId = new mongoose.Types.ObjectId(tech._id);

    // Calculate total earnings (sum of all credit transactions)
    const totalEarningsResult = await WalletTransaction.aggregate([
      {
        $match: {
          technicianId: techId,
          type: "credit"
        }
      },
      {
        $group: {
          _id: null,
          total: { $sum: "$amount" }
        }
      }
    ]);

    const totalEarnings = totalEarningsResult[0]?.total || 0;

    // Calculate withdrawal stats
    const withdrawalStats = await WithdrawRequest.aggregate([
      {
        $match: {
          technicianId: techId
        }
      },
      {
        $group: {
          _id: null,
          approvedTotal: {
            $sum: {
              $cond: [{ $eq: ["$status", "approved"] }, "$amount", 0]
            }
          },
          approvedCount: {
            $sum: {
              $cond: [{ $eq: ["$status", "approved"] }, 1, 0]
            }
          },
          rejectedCount: {
            $sum: {
              $cond: [{ $eq: ["$status", "rejected"] }, 1, 0]
            }
          },
          pendingTotal: {
            $sum: {
              $cond: [{ $eq: ["$status", "pending"] }, "$amount", 0]
            }
          },
          pendingCount: {
            $sum: {
              $cond: [{ $eq: ["$status", "pending"] }, 1, 0]
            }
          }
        }
      }
    ]);

    const stats = withdrawalStats[0] || {
      approvedTotal: 0,
      approvedCount: 0,
      rejectedCount: 0,
      pendingTotal: 0,
      pendingCount: 0
    };

    res.json({
      success: true,
      //sk
      balance: tech?.walletBalance || 0,
      totalEarnings,
      stats
    });
  } catch (error) {
    console.error("Error in getTechnicianWallet:", error);
    res.status(500).json({ success: false, message: "Internal Server Error", error: error.message });
  }
};

/* GET WALLET TRANSACTIONS */
export const getWalletTransactions = async (req, res) => {
  // ensureTechnician(req); // Handled by middleware //sk

  //sk
  let query = { technicianId: req.technician._id };

  if (req.query.startDate || req.query.endDate) {
    query.createdAt = {};
    if (req.query.startDate) {
      query.createdAt.$gte = new Date(req.query.startDate);
    }
    if (req.query.endDate) {
      // Set end date to end of day
      const end = new Date(req.query.endDate);
      end.setHours(23, 59, 59, 999);
      query.createdAt.$lte = end;
    }
  }

  const txns = await WalletTransaction.find(query).sort({ createdAt: -1 });

  res.json({ success: true, result: txns });
};



/* REQUEST WITHDRAW */
export const requestWithdraw = async (req, res) => {
  // ensureTechnician(req); // Handled by middleware 
 //sk

  // Check if today is Friday
  const today = new Date();
  if (today.getDay() !== 5) {
    return res.status(400).json({
      success: false,
      message: "Withdrawal requests are only allowed on Fridays"
    });
  }

  const { amount } = req.body;
  //sk
  const config = getConfig(); // Get config

  if (!amount || amount <= 0) {
    return res.status(400).json({ success: false, message: "Invalid amount" });
  }
//sk
  if (amount < config.minWithdrawal) {
    return res.status(400).json({
      success: false,
      message: `Minimum withdrawal amount is ₹${config.minWithdrawal}`
    });
  }

  const tech = req.technician; //sk
  if (tech.walletBalance < amount) {
    return res.status(400).json({ success: false, message: "Insufficient balance" });
  }

  const withdraw = await WithdrawRequest.create({
    technicianId: req.technician._id, //sk
    amount
  });

  res.json({ success: true, message: "Withdraw request sent", result: withdraw });
};

/* MY WITHDRAW REQUESTS */
export const getMyWithdrawRequests = async (req, res) => {
  // ensureTechnician(req); // Handled by middleware //sk

  const data = await WithdrawRequest.find({
    technicianId: req.technician._id //sk
  }).sort({ createdAt: -1 }); //sk

  res.json({ success: true, result: data });
};

/* ================= CANCEL MY WITHDRAW ================= */
export const cancelMyWithdrawal = async (req, res) => {
  try {
    // Role check handled by verifyRoles or isTechnician if applied //sk
    if (req.user?.role !== "Technician" || !req.technician) { //sk
      return res.status(403).json({
        success: false,
        message: "Technician access only" //sk
      });
    }

    const { id } = req.params;

    const withdraw = await WithdrawRequest.findOne({
      _id: id,
      technicianId: req.technician._id,//sk
      status: "pending"
    });

    if (!withdraw) {
      return res.status(404).json({
        success: false,
        message: "Pending withdraw request not found"
      });
    }

    withdraw.status = "rejected";
    withdraw.rejectedAt = new Date();
    withdraw.adminNote = "Cancelled by technician";
    await withdraw.save();

    return res.json({
      success: true,
      message: "Withdraw request cancelled successfully"
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};
