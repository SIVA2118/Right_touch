import express from "express";
import { Auth, authorizeRoles } from "../Middleware/Auth.js";
import {
  createAddress,
  getMyAddresses,
  updateAddress,
  deleteAddress,
  setDefaultAddress,
  getDefaultAddress,
  adminGetAllAddresses,
  adminGetAddressById,
} from "../Controllers/addressController.js";

const router = express.Router();

/* ================= ADMIN ONLY ================= */
router.get("/admin/all", Auth, authorizeRoles("Admin", "Owner"), adminGetAllAddresses);
router.get("/admin/:id", Auth, authorizeRoles("Admin", "Owner"), adminGetAddressById);

// Create address
router.post("/", Auth, createAddress);

// Get all addresses for user
router.get("/", Auth, getMyAddresses);

// Get default address
router.get("/default", Auth, getDefaultAddress);

// Update address (customer) - pass addressId in body
router.put("/", Auth, updateAddress);

// Set as default address (customer) - pass addressId in body
router.put("/default", Auth, setDefaultAddress);

// Delete address (customer) - pass addressId in body
router.delete("/", Auth, deleteAddress);

export default router;
