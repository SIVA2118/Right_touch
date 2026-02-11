import express from "express";
import { Auth } from "../Middleware/Auth.js";
import isTechnician from "../Middleware/isTechnician.js";

import {
  getTechnicianWallet,
  getWalletTransactions,
  requestWithdraw,
  getMyWithdrawRequests
} from "../Controllers/technicianWalletController.js";

const router = express.Router();

/* ================= TECHNICIAN WALLET ================= */

//sk
// Wallet balance
// Wallet balance
router.get("/wallet", Auth, isTechnician, getTechnicianWallet);

// Wallet transactions (credits / debits)
// Wallet transactions (credits / debits)
router.get("/wallet/transactions", Auth, isTechnician, getWalletTransactions);

// Withdraw request
// Withdraw request
router.post("/wallet/withdraw", Auth, isTechnician, requestWithdraw);

// My withdraw history
// My withdraw history
router.get("/wallet/withdraws", Auth, isTechnician, getMyWithdrawRequests);

export default router;
