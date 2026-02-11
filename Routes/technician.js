import express from "express";
import { Auth } from "../Middleware/Auth.js";
import isTechnician from "../Middleware/isTechnician.js";
import { upload } from "../Utils/cloudinaryUpload.js";
import {
  updateTechnicianLocation,
  createTechnician,
  getAllTechnicians,
  getTechnicianById,
  getMyTechnician,
  updateTechnician,
  addTechnicianSkills,
  removeTechnicianSkills,
  updateTechnicianStatus,
  deleteTechnician,
  updateTechnicianTraining,
  uploadProfileImage,
} from "../Controllers/technician.js";
import { technicianLogin, verifyTechnicianOtp } from "../Controllers/User.js";
import { respondToJob, getMyJobs } from "../Controllers/technicianBroadcastController.js";
import {
  submitTechnicianKyc,
  uploadTechnicianKycDocuments,
  getTechnicianKyc,
  getMyTechnicianKyc,
  getAllTechnicianKyc,
  verifyTechnicianKyc,
  verifyBankDetails,
  deleteTechnicianKyc,
  getOrphanedKyc,
  deleteOrphanedKyc,
  deleteAllOrphanedKyc,
} from "../Controllers/technicianKycController.js";
import { updateBookingStatus, getTechnicianJobHistory, getTechnicianCurrentJobs } from "../Controllers/serviceBookController.js";
import { createWalletTransaction, getWalletTransactions, requestWithdraw, getMyWithdrawRequests, cancelMyWithdrawal } from "../Controllers/technicianWalletController.js";




const router = express.Router();


/* ================= TECHNICIAN AUTH ================= */
router.post("/login/technician", technicianLogin);
router.post("/login/technician/verify-otp", verifyTechnicianOtp);
router.put("/location", Auth, isTechnician, updateTechnicianLocation);
router.post("/technicianData", Auth, createTechnician);
router.get("/technicianAll", Auth, getAllTechnicians);
router.get("/technicianById/:id", Auth, getTechnicianById);
router.get("/technician/me", Auth, getMyTechnician);
router.put("/updateTechnician", Auth, updateTechnician);
router.put("/technician/skills/add", Auth, isTechnician, addTechnicianSkills);
router.put("/technician/skills/remove", Auth, isTechnician, removeTechnicianSkills);
router.put("/technician/status", Auth, updateTechnicianStatus);
router.put("/:technicianId/training", Auth, updateTechnicianTraining);
router.post("/technician/profile-image", Auth, isTechnician, upload.single("profileImage"), uploadProfileImage);
router.delete("/technicianDelete/:id", Auth, deleteTechnician);

/* ================= TECHNICIAN KYC ================= */

router.post("/technician/kyc", Auth, isTechnician, submitTechnicianKyc);

router.post(
  "/technician/kyc/upload",
  Auth,
  isTechnician,
  upload.fields([
    { name: "aadhaarImage", maxCount: 1 },
    { name: "panImage", maxCount: 1 },
    { name: "dlImage", maxCount: 1 },
  ]),
  uploadTechnicianKycDocuments
);

// IMPORTANT: define '/me' BEFORE '/:technicianId' so 'me' doesn't get treated as an id.
router.get("/technician/kyc/me", Auth, isTechnician, getMyTechnicianKyc);
router.get("/technician/kyc", Auth, getAllTechnicianKyc);
router.get("/technician/kyc/:technicianId", Auth, getTechnicianKyc);
router.put("/technician/kyc/verify", Auth, verifyTechnicianKyc);
router.put("/technician/kyc/bank/verify", Auth, verifyBankDetails);
router.delete("/technician/deletekyc/:technicianId", Auth, deleteTechnicianKyc);
router.get("/technician/kyc/orphaned/list", Auth, getOrphanedKyc);
router.delete("/technician/kyc/orphaned/:kycId", Auth, deleteOrphanedKyc);
router.delete("/technician/kyc/orphaned/cleanup/all", Auth, deleteAllOrphanedKyc);

/* ================= JOB BROADCAST ================= */

router.get("/job-broadcast/my-jobs", Auth, isTechnician, getMyJobs);

router.put("/job-broadcast/respond/:id", Auth, respondToJob);

/* ================= JOB UPDATE ================= */

// Technician updates job status

router.put("/status/:id", Auth, isTechnician, updateBookingStatus);
router.get("/jobs/current", Auth, getTechnicianCurrentJobs); // Supports both Technician and Owner roles
router.get("/jobs/history", Auth, isTechnician, getTechnicianJobHistory);

/* ================= TECHNICIAN WALLET ================= */

router.post("/wallet/transaction", Auth, createWalletTransaction);
router.get("/wallet/history", Auth, isTechnician, getWalletTransactions);

// Technician payout requests
router.post("/wallet/withdrawals/request", Auth, isTechnician, requestWithdraw);
router.get("/wallet/withdrawals/me", Auth, isTechnician, getMyWithdrawRequests);
router.put("/wallet/withdrawals/:id/cancel", Auth, isTechnician, cancelMyWithdrawal);

export default router;
