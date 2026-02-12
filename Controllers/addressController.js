import mongoose from "mongoose";

import Address from "../Schemas/Address.js";
import User from "../Schemas/User.js";
import { ensureCustomer } from "../Utils/ensureCustomer.js";

const getAddressIdFromReq = (req) => req.params?.id || req.body?.addressId || req.body?.id;

/* ================= CREATE ADDRESS ================= */

export const createAddress = async (req, res) => {
  try {
    ensureCustomer(req);
    const customerId = req.user.userId;

    const {
      label,
      name,
      phone,
      addressLine,
      city,
      state,
      pincode,
      latitude,
      longitude,
      isDefault,
    } = req.body;

    console.log(req.body);

    // Clean inputs
    const cleanAddressLine = typeof addressLine === 'string' ? addressLine.trim() : "";

    // Convert latitude and longitude from string to number
    let cleanLat = undefined;
    let cleanLng = undefined;

    if (latitude !== undefined && latitude !== null && latitude !== '') {
      const latNum = Number(latitude);
      cleanLat = Number.isFinite(latNum) ? latNum : undefined;
    }

    if (longitude !== undefined && longitude !== null && longitude !== '') {
      const lngNum = Number(longitude);
      cleanLng = Number.isFinite(lngNum) ? lngNum : undefined;
    }

    if (!cleanAddressLine && (cleanLat === undefined || cleanLng === undefined)) {
      return res.status(400).json({
        success: false,
        message: "Address line OR location coordinates are required",
        result: {},
      });
    }

    const finalAddressLine = cleanAddressLine || "Pinned Location";

    // 🔒 Optional safety limit
    const count = await Address.countDocuments({ customerId });
    if (count >= 10) {
      return res.status(400).json({
        success: false,
        message: "Address limit reached",
        result: {},
      });
    }

    // 🔒 Ensure single default address
    if (isDefault) {
      await Address.updateMany(
        { customerId },
        { isDefault: false }
      );
    }

    // ✅ Get user profile for fallback name and phone
    const customer = await User.findById(customerId).select(
      "fname lname mobileNumber email"
    );

    if (!customer) {
      return res.status(404).json({
        success: false,
        message: "Customer profile not found",
        result: {},
      });
    }

    // Derive name and phone from user profile if not complete
    const profileName = [customer.fname, customer.lname]
      .filter(Boolean)
      .join(" ")
      .trim();

    const profilePhone = customer.mobileNumber;

    // Check if profile is complete
    if (!profileName || !profilePhone) {
      return res.status(400).json({
        success: false,
        message: "Please complete your profile (fname, mobileNumber) before adding an address",
        result: {},
      });
    }

    // Use provided name/phone or fallback to profile data
    const finalName = (name && name.trim()) || profileName;
    const finalPhone = (phone && phone.trim()) || profilePhone;

    // Validate phone format if provided
    if (finalPhone && !/^[0-9]{10}$/.test(finalPhone)) {
      return res.status(400).json({
        success: false,
        message: "Phone must be 10 digits",
        result: {},
      });
    }

    // Validate coordinates if provided
    if ((cleanLat !== undefined || cleanLng !== undefined) && (cleanLat === undefined || cleanLng === undefined)) {
      return res.status(400).json({
        success: false,
        message: "Both latitude and longitude must be provided together",
        result: {},
      });
    }

    const address = await Address.create({
      customerId,
      label: label || "home",
      name: finalName,
      phone: finalPhone,
      addressLine: finalAddressLine,
      city,
      state,
      pincode,
      latitude: cleanLat,
      longitude: cleanLng,
      isDefault: Boolean(isDefault),
    });

    return res.status(201).json({
      success: true,
      message: "Address created successfully",
      result: address,
    });
  } catch (error) {
    console.error("Create address error:", error);
    return res.status(error?.statusCode || 500).json({
      success: false,
      message: error.message || "Failed to create address",
      result: {},
    });
  }
};


/* ================= GET ALL ADDRESSES ================= */
export const getMyAddresses = async (req, res) => {
  try {
    ensureCustomer(req);

    const addresses = await Address.find({
      customerId: req.user.userId,
    })
      .populate("customerId", "fname lname mobileNumber email")
      .sort({ isDefault: -1, createdAt: -1 });

    res.json({
      success: true,
      result: addresses,
    });
  } catch (err) {
    res.status(err?.statusCode || 500).json({
      success: false,
      message: err.message,
      result: {},
    });
  }
};


/* ================= GET SINGLE ADDRESS ================= */
export const getAddressById = async (req, res) => {
  try {
    ensureCustomer(req);

    const addressId = getAddressIdFromReq(req);
    if (!addressId) {
      return res.status(400).json({
        success: false,
        message: "addressId is required",
        result: {},
      });
    }

    if (!mongoose.Types.ObjectId.isValid(addressId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid address id",
        result: {},
      });
    }

    const address = await Address.findOne({
      _id: addressId,
      customerId: req.user.userId,
    }).populate("customerId", "fname lname mobileNumber email");

    if (!address) {
      return res.status(404).json({
        success: false,
        message: "Address not found",
        result: {},
      });
    }

    res.json({ success: true, result: address });
  } catch (err) {
    res.status(err?.statusCode || 500).json({
      success: false,
      message: err.message,
      result: {},
    });
  }
};

/* ================= UPDATE ADDRESS ================= */
export const updateAddress = async (req, res) => {
  try {
    ensureCustomer(req);

    const id = getAddressIdFromReq(req);
    if (!id) {
      return res.status(400).json({
        success: false,
        message: "addressId is required",
        result: {},
      });
    }

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid address id",
        result: {},
      });
    }

    const address = await Address.findOne({
      _id: id,
      customerId: req.user.userId,
    });

    if (!address) {
      return res.status(404).json({
        success: false,
        message: "Address not found",
        result: {},
      });
    }

    if (req.body.isDefault) {
      await Address.updateMany(
        { customerId: req.user.userId, _id: { $ne: id } },
        { isDefault: false }
      );
    }

    // Only allow safe updates
    const allowed = [
      "label",
      "name",
      "phone",
      "addressLine",
      "city",
      "state",
      "pincode",
      "latitude",
      "longitude",
      "isDefault",
    ];

    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        // Validate phone format if being updated
        if (key === "phone" && req.body[key]) {
          const phoneStr = String(req.body[key]).trim();
          if (!/^[0-9]{10}$/.test(phoneStr)) {
            return res.status(400).json({
              success: false,
              message: "Phone must be 10 digits",
              result: {},
            });
          }
          address[key] = phoneStr;
        } else if (key === "latitude" || key === "longitude") {
          // Convert latitude/longitude to number if provided as string
          if (req.body[key] !== null && req.body[key] !== '') {
            const coordNum = Number(req.body[key]);
            address[key] = Number.isFinite(coordNum) ? coordNum : undefined;
          } else {
            address[key] = req.body[key];
          }
        } else {
          address[key] = req.body[key];
        }
      }
    }

    await address.save();

    res.json({ success: true, result: address });
  } catch (err) {
    res.status(err?.statusCode || 500).json({
      success: false,
      message: err.message,
      result: {},
    });
  }
};


/* ================= DELETE ADDRESS ================= */
export const deleteAddress = async (req, res) => {
  try {
    ensureCustomer(req);

    const id = getAddressIdFromReq(req);
    if (!id) {
      return res.status(400).json({
        success: false,
        message: "addressId is required",
        result: {},
      });
    }

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid address id",
        result: {},
      });
    }

    const address = await Address.findOneAndDelete({
      _id: id,
      customerId: req.user.userId,
    });

    if (!address) {
      return res.status(404).json({
        success: false,
        message: "Address not found",
        result: {},
      });
    }

    res.status(200).json({
      success: true,
      message: "Address deleted successfully",
      result: {},
    });
  } catch (error) {
    console.error("Delete address error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to delete address",
      result: { reason: error.message || "An error occurred" },
    });
  }
};

/* ================= SET DEFAULT ADDRESS ================= */
export const setDefaultAddress = async (req, res) => {
  try {
    ensureCustomer(req);

    const id = getAddressIdFromReq(req);
    if (!id) {
      return res.status(400).json({
        success: false,
        message: "addressId is required",
        result: {},
      });
    }

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid address id",
        result: {},
      });
    }

    // Check if address exists and belongs to customer
    const address = await Address.findOne({
      _id: id,
      customerId: req.user.userId,
    });

    if (!address) {
      return res.status(404).json({
        success: false,
        message: "Address not found",
        result: {},
      });
    }

    // Unset all other defaults
    await Address.updateMany(
      { customerId: req.user.userId, _id: { $ne: id } },
      { isDefault: false }
    );

    // Set this as default
    const updatedAddress = await Address.findByIdAndUpdate(
      id,
      { isDefault: true },
      { new: true }
    );

    res.status(200).json({
      success: true,
      message: "Default address updated",
      result: updatedAddress,
    });
  } catch (error) {
    console.error("Set default address error:", error);
    res.status(error?.statusCode || 500).json({
      success: false,
      message: error.message || "Failed to set default address",
      result: { reason: error.message || "An error occurred" },
    });
  }
};

/* ================= GET DEFAULT ADDRESS ================= */
export const getDefaultAddress = async (req, res) => {
  try {
    ensureCustomer(req);

    const address = await Address.findOne({
      customerId: req.user.userId,
      isDefault: true,
    }).populate("customerId", "fname lname mobileNumber email");

    if (!address) {
      //sk
      return res.status(200).json({
        success: true,
        message: "No default address set",
        result: null,
      });
    }

    res.status(200).json({
      success: true,
      message: "Default address fetched successfully",
      result: address,
    });
  } catch (error) {
    console.error("Get default address error:", error);
    res.status(error?.statusCode || 500).json({
      success: false,
      message: error.message || "Failed to fetch default address",
      result: { reason: error.message || "An error occurred" },
    });
  }
};

/* ================= ADMIN: GET ALL ADDRESSES ================= */
export const adminGetAllAddresses = async (req, res) => {
  try {
    const addresses = await Address.find()
      .populate("customerId", "fname lname mobileNumber email")
      .sort({ createdAt: -1 });
    res.json({ success: true, result: addresses });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message, result: {} });
  }
};

/* ================= ADMIN: GET ADDRESS BY ID ================= */
export const adminGetAddressById = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid address id", result: {} });
    }

    const address = await Address.findById(id).populate(
      "customerId",
      "fname lname mobileNumber email"
    );
    if (!address) {
      return res.status(404).json({ success: false, message: "Address not found", result: {} });
    }

    res.json({ success: true, result: address });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message, result: {} });
  }
};
