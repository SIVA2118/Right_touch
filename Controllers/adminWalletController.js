import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import WithdrawRequest from "../Schemas/WithdrawRequest.js";
import WalletTransaction from "../Schemas/WalletTransaction.js";
import Payment from "../Schemas/Payment.js";

/* 🔐 Admin only */
const ensureAdmin = (req) => {
  const role = req.user?.role;
  if (role !== "Admin" && role !== "Owner") {
    const err = new Error("Admin or Owner access only");
    err.statusCode = 403;
    throw err;
  }
};


/* WALLET SUMMARY */
export const getAdminWalletSummary = async (req, res) => {
  ensureAdmin(req);

  //sk
  const now = new Date();
  const startOfToday = new Date(now.setHours(0, 0, 0, 0));
  const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const startOfYear = new Date(new Date().getFullYear(), 0, 1);

  const payments = await Payment.aggregate([
    { $match: { status: "success" } },
    {
      $group: {
        _id: null,
        // Overall
        overallCollected: { $sum: "$totalAmount" },
        overallCommission: { $sum: "$commissionAmount" },
        // Today
        todayCollected: {
          $sum: {
            $cond: [{ $gte: ["$createdAt", startOfToday] }, "$totalAmount", 0]
          }
        },
        todayCommission: {
          $sum: {
            $cond: [{ $gte: ["$createdAt", startOfToday] }, "$commissionAmount", 0]
          }
        },
        // Month
        monthCollected: {
          $sum: {
            $cond: [{ $gte: ["$createdAt", startOfMonth] }, "$totalAmount", 0]
          }
        },
        monthCommission: {
          $sum: {
            $cond: [{ $gte: ["$createdAt", startOfMonth] }, "$commissionAmount", 0]
          }
        },
        // Year
        yearCollected: {
          $sum: {
            $cond: [{ $gte: ["$createdAt", startOfYear] }, "$totalAmount", 0]
          }
        },
        yearCommission: {
          $sum: {
            $cond: [{ $gte: ["$createdAt", startOfYear] }, "$commissionAmount", 0]
          }
        }
      }
    }
  ]);

  const stats = payments[0] || {
    overallCollected: 0, overallCommission: 0,
    todayCollected: 0, todayCommission: 0,
    monthCollected: 0, monthCommission: 0,
    yearCollected: 0, yearCommission: 0
  };

  // sk - Aggregate Withdraw Requests
  const withdrawStats = await WithdrawRequest.aggregate([
    {
      $group: {
        _id: null,
        totalApprovedAmount: {
          $sum: { $cond: [{ $eq: ["$status", "approved"] }, "$amount", 0] }
        },
        approvedCount: {
          $sum: { $cond: [{ $eq: ["$status", "approved"] }, 1, 0] }
        },
        rejectedCount: {
          $sum: { $cond: [{ $eq: ["$status", "rejected"] }, 1, 0] }
        }
      }
    }
  ]);

  const wStats = withdrawStats[0] || { totalApprovedAmount: 0, approvedCount: 0, rejectedCount: 0 };
  const totalWithdrawn = wStats.totalApprovedAmount;

  // Helper to round
  const r = (n) => Math.round(n || 0);

  res.json({
    success: true,
    result: {
      //sk
      totalPendingWithdrawals: r(stats.totalPendingWithdrawals),
      // Existing fields maintained for compatibility if needed
      totalCollected: r(stats.overallCollected),
      totalCommission: r(stats.overallCommission),
      availableBalance: r(stats.overallCollected - totalWithdrawn),
      //sk
      // Withdraw Stats
      totalWithdrawn: r(totalWithdrawn),
      approvedWithdrawCount: wStats.approvedCount,
      rejectedWithdrawCount: wStats.rejectedCount,

      // Breakdown

      //sk
      // Breakdown
      overall: {
        collected: r(stats.overallCollected),
        commission: r(stats.overallCommission),
        netPayout: r(stats.overallCollected - stats.overallCommission)
      },
      today: {
        collected: r(stats.todayCollected),
        commission: r(stats.todayCommission),
        netPayout: r(stats.todayCollected - stats.todayCommission)
      },
      month: {
        collected: r(stats.monthCollected),
        commission: r(stats.monthCommission),
        netPayout: r(stats.monthCollected - stats.monthCommission)
      },
      year: {
        collected: r(stats.yearCollected),
        commission: r(stats.yearCommission),
        netPayout: r(stats.yearCollected - stats.yearCommission)
      }
    },
  });
};

/* ALL WITHDRAWS */
export const getAllWithdrawRequests = async (req, res) => {
  ensureAdmin(req);

  //sk
  const { type, date, month, year } = req.query;
  let filter = {};

  if (type) {
    let startDate, endDate;
    try {
      if (type === "day") {
        if (date) {
          startDate = new Date(date);
          startDate.setHours(0, 0, 0, 0);
          endDate = new Date(date);
          endDate.setHours(23, 59, 59, 999);
        }
      } else if (type === "month") {
        if (month) {
          const [y, m] = month.split("-");
          startDate = new Date(y, m - 1, 1);
          endDate = new Date(y, m, 0, 23, 59, 59, 999);
        }
      } else if (type === "year") {
        if (year) {
          startDate = new Date(year, 0, 1);
          endDate = new Date(year, 11, 31, 23, 59, 59, 999);
        }
      }

      if (startDate && endDate) {
        filter.createdAt = { $gte: startDate, $lte: endDate };
      }
    } catch (error) {
      console.error("Date filter error:", error);
    }
  }

  const data = await WithdrawRequest.find(filter)
    .populate("technicianId", "name mobileNumber walletBalance")
    .sort({ createdAt: -1 });

  res.json({ success: true, result: data });
};

/* APPROVE */
export const approveWithdraw = async (req, res) => {
  ensureAdmin(req);

  const withdraw = await WithdrawRequest.findById(req.params.id);
  if (!withdraw || withdraw.status !== "pending") {
    return res.status(400).json({ success: false, message: "Invalid request" });
  }

  await TechnicianProfile.updateOne(
    { _id: withdraw.technicianId },
    { $inc: { walletBalance: -withdraw.amount } }
  );

  await WalletTransaction.create({
    technicianId: withdraw.technicianId,
    amount: withdraw.amount,
    type: "debit",
    source: "withdraw",
    note: "Withdraw approved"
  });

  withdraw.status = "approved";
  await withdraw.save();

  res.json({ success: true, message: "Withdraw approved" });
};

/* REJECT */
export const rejectWithdraw = async (req, res) => {
  ensureAdmin(req);

  const withdraw = await WithdrawRequest.findById(req.params.id);
  if (!withdraw || withdraw.status !== "pending") {
    return res.status(400).json({ success: false, message: "Invalid request" });
  }

  withdraw.status = "rejected";
  await withdraw.save();

  res.json({ success: true, message: "Withdraw rejected" });
};
//sk
/* FILTER WALLET STATS */
export const getFilterWalletStats = async (req, res) => {
  ensureAdmin(req);

  const { type, date, month, year } = req.query; // type: 'day', 'month', 'year'

  let startDate, endDate;

  try {
    if (type === "day") {
      if (!date) throw new Error("Date is required for 'day' filter");
      startDate = new Date(date);
      startDate.setHours(0, 0, 0, 0);
      endDate = new Date(date);
      endDate.setHours(23, 59, 59, 999);
    } else if (type === "month") {
      // month input is usually "YYYY-MM"
      if (!month) throw new Error("Month is required for 'month' filter");
      const [y, m] = month.split("-");
      startDate = new Date(y, m - 1, 1);
      endDate = new Date(y, m, 0, 23, 59, 59, 999);
    } else if (type === "year") {
      if (!year) throw new Error("Year is required for 'year' filter");
      startDate = new Date(year, 0, 1);
      endDate = new Date(year, 11, 31, 23, 59, 59, 999);
    } else {
      throw new Error("Invalid filter type");
    }
  } catch (err) {
    return res.status(400).json({ success: false, message: err.message });
  }

  const payments = await Payment.aggregate([
    {
      $match: {
        status: "success",
        createdAt: { $gte: startDate, $lte: endDate }
      }
    },
    {
      $group: {
        _id: null,
        collected: { $sum: "$totalAmount" },
        commission: { $sum: "$commissionAmount" }
      }
    }
  ]);

  const stats = payments[0] || { collected: 0, commission: 0 };
  const r = (n) => Math.round(n || 0);

  res.json({
    success: true,
    result: {
      type,
      range: { start: startDate, end: endDate },
      collected: r(stats.collected),
      commission: r(stats.commission),
      netPayout: r(stats.collected - stats.commission)
    }
  });
};
