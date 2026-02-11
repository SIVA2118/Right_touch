import express from "express";
import { Auth } from "../Middleware/Auth.js";
import { getFilterWalletStats } from "../Controllers/adminWalletController.js";

import {
  getAdminWalletSummary,
  getAllWithdrawRequests,
  approveWithdraw,
  rejectWithdraw
} from "../Controllers/adminWalletController.js";

const router = express.Router();

/* ================= ADMIN WALLET ================= */


// Summary
router.get("/wallet", Auth, getAdminWalletSummary);

// All withdraw requests
router.get("/wallet/withdraws", Auth, getAllWithdrawRequests);
router.get("/wallet/withdrawals", Auth, getAllWithdrawRequests); // Alias for HTML
//sk
// Filter Stats
router.get("/wallet/filter", Auth, getFilterWalletStats);

// Decide withdraw
router.put("/wallet/withdraw/:id/approve", Auth, approveWithdraw);
router.put("/wallet/withdraw/:id/reject", Auth, rejectWithdraw);
router.put("/wallet/withdrawals/:id/approve", Auth, approveWithdraw); // Alias for HTML
router.put("/wallet/withdrawals/:id/reject", Auth, rejectWithdraw); // Alias for HTML

export default router;
