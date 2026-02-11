import Cart from "../Schemas/Cart.js";
import Product from "../Schemas/Product.js";
import Service from "../Schemas/Service.js";
import ServiceBooking from "../Schemas/ServiceBooking.js";
import ProductBooking from "../Schemas/ProductBooking.js";
import Address from "../Schemas/Address.js";
import User from "../Schemas/User.js";
import JobBroadcast from "../Schemas/TechnicianBroadcast.js";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import mongoose from "mongoose";
import { matchAndBroadcastBooking } from "../Utils/technicianMatching.js";
import { resolveUserLocation } from "../Utils/resolveUserLocation.js";
import { ensureCustomer } from "../Utils/ensureCustomer.js";
import {
  SERVICE_BOOKING_STATUS,
  PRODUCT_BOOKING_STATUS,
  PAYMENT_STATUS,
} from "../Utils/constants.js";




const toFiniteNumber = (v) => {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" && v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};


const normalizeAddressId = (v) => {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed === "" || trimmed === "null" || trimmed === "undefined" ? null : trimmed;
};

const getErrorMessage = (error) => {
  if (error.code === 11000) {
    return "Item already exists in cart with same ID";
  }
  if (error.statusCode) {
    return error.message;
  }
  return "An error occurred. Please try again.";
};

/* ================= ADD TO CART ================= */
export const addToCart = async (req, res) => {
  try {

    ensureCustomer(req);
    const { itemId, itemType, quantity = 1 } = req.body;
    const customerId = req.user.userId;

    if (!customerId) {
      return res.status(401).json({
        success: false,
        message: "Customer ID not found in token",
        result: {},
      });
    }

    if (!itemId || !itemType) {
      return res.status(400).json({
        success: false,
        message: "Item ID and item type are required",
        result: {},
      });
    }

    if (!["product", "service"].includes(itemType)) {
      return res.status(400).json({
        success: false,
        message: "Invalid item type. Must be 'product' or 'service'",
        result: {},
      });
    }

    if (!Number.isInteger(quantity) || quantity <= 0) {
      return res.status(400).json({
        success: false,
        message: "Quantity must be a positive integer",
        result: {},
      });
    }

    // Check if item exists
    const item = itemType === "product"
      ? await Product.findById(itemId)
      : await Service.findById(itemId);

    if (!item) {
      return res.status(404).json({
        success: false,
        message: `${itemType} not found`,
        result: {},
      });
    }

    // Add or update cart item - increment quantity if exists, create if not
    let cartItem = await Cart.findOneAndUpdate(
      { customerId, itemType, itemId },
      { $inc: { quantity } },
      { new: true, runValidators: true, upsert: false }
    );

    // If not found, insert new item
    if (!cartItem) {
      try {
        cartItem = await Cart.create({
          customerId,
          itemType,
          itemId,
          quantity,
        });
      } catch (createError) {
        // Handle race condition: another request created it while we were checking
        if (createError.code === 11000) {
          cartItem = await Cart.findOneAndUpdate(
            { customerId, itemType, itemId },
            { $set: { quantity } },
            { new: true, runValidators: true }
          );
        } else {
          throw createError;
        }
      }
    }

    // Safety check: ensure cart item was created/updated
    if (!cartItem) {
      console.error("CRITICAL: Cart item is null after all operations!");
      return res.status(500).json({
        success: false,
        message: "Failed to save cart item",
        result: { reason: "Database operation failed. Please try again." },
      });
    }

    res.status(200).json({
      success: true,
      message: `${itemType} added to cart`,
      result: cartItem,
    });
  } catch (error) {
    console.error("Add to cart error:", error);
    const statusCode = error.code === 11000 ? 400 : (error.statusCode || 500);
    res.status(statusCode).json({
      success: false,
      message: "Failed to add item to cart",
      result: { reason: getErrorMessage(error) },
    });
  }
};

/* ================= GET MY CART ================= */
export const getMyCart = async (req, res) => {
  try {
    ensureCustomer(req);
    const customerId = req.user.userId;

    const cartItems = await Cart.find({ customerId });

    // Populate items based on type (uses populate; keeps response shape the same)
    await Promise.all(
      cartItems.map(async (cartItem) => {
        const model = cartItem.itemType === "product" ? "Product" : "Service";
        await cartItem.populate({ path: "itemId", model });
      })
    );

    const populatedItems = cartItems.map((cartItem) => {
      const obj = cartItem.toObject();
      const isPopulated = obj.itemId && typeof obj.itemId === "object" && obj.itemId._id;

      return {
        ...obj,
        itemId: isPopulated ? obj.itemId._id : obj.itemId,
        item: isPopulated ? obj.itemId : null,
      };
    });

    res.status(200).json({
      success: true,
      message: "Cart fetched successfully",
      result: populatedItems,
    });
  } catch (error) {
    console.error("Get my cart error:", error);
    res.status(error.statusCode || 500).json({
      success: false,
      message: "Failed to fetch cart",
      result: { reason: getErrorMessage(error) },
    });
  }
};

/* ================= UPDATE CART ITEM ================= */
export const updateCartItem = async (req, res) => {
  try {
    ensureCustomer(req);
    const { itemId, itemType, quantity } = req.body;
    const customerId = req.user.userId;

    if (!itemId || !itemType || quantity == null) {
      return res.status(400).json({
        success: false,
        message: "Item ID, item type, and quantity are required",
        result: {},
      });
    }

    if (!["product", "service"].includes(itemType)) {
      return res.status(400).json({
        success: false,
        message: "Invalid item type. Must be 'product' or 'service'",
        result: {},
      });
    }

    if (!Number.isInteger(quantity)) {
      return res.status(400).json({
        success: false,
        message: "Quantity must be an integer",
        result: {},
      });
    }

    if (quantity <= 0) {
      // If quantity is 0 or negative, remove the item
      await Cart.findOneAndDelete({ customerId, itemType, itemId });
      return res.status(200).json({
        success: true,
        message: "Item removed from cart",
        result: {},
      });
    }

    const cartItem = await Cart.findOneAndUpdate(
      { customerId, itemType, itemId },
      { quantity },
      { new: true, runValidators: true }
    );

    if (!cartItem) {
      return res.status(404).json({
        success: false,
        message: "Cart item not found",
        result: {},
      });
    }

    res.status(200).json({
      success: true,
      message: "Cart item updated",
      result: cartItem,
    });
  } catch (error) {
    console.error("Update cart item error:", error);
    res.status(error.statusCode || 500).json({
      success: false,
      message: "Failed to update cart item",
      result: { reason: getErrorMessage(error) },
    });
  }
};

/* ================= GET CART BY ID ================= */
export const getCartById = async (req, res) => {
  try {
    ensureCustomer(req);
    const { id } = req.params;
    const customerId = req.user.userId;

    const cartItem = await Cart.findOne({ _id: id, customerId });

    if (!cartItem) {
      return res.status(404).json({
        success: false,
        message: "Cart item not found",
        result: {},
      });
    }

    // Populate the item (uses populate; keeps response shape the same)
    const model = cartItem.itemType === "product" ? "Product" : "Service";
    await cartItem.populate({ path: "itemId", model });

    const obj = cartItem.toObject();
    const isPopulated = obj.itemId && typeof obj.itemId === "object" && obj.itemId._id;
    const item = isPopulated ? obj.itemId : null;

    res.status(200).json({
      success: true,
      message: "Cart item fetched",
      result: {
        ...obj,
        itemId: isPopulated ? obj.itemId._id : obj.itemId,
        item,
      },
    });
  } catch (error) {
    console.error("Get cart by id error:", error);
    res.status(error.statusCode || 500).json({
      success: false,
      message: "Failed to fetch cart item",
      result: { reason: getErrorMessage(error) },
    });
  }
};

/* ================= UPDATE CART BY ID ================= */
export const updateCartById = async (req, res) => {
  try {
    ensureCustomer(req);
    const { id } = req.params;
    const { quantity } = req.body;
    const customerId = req.user.userId;

    if (quantity == null) {
      return res.status(400).json({
        success: false,
        message: "Quantity is required",
        result: {},
      });
    }

    if (!Number.isInteger(quantity)) {
      return res.status(400).json({
        success: false,
        message: "Quantity must be an integer",
        result: {},
      });
    }

    if (quantity <= 0) {
      // Remove the item
      const deletedItem = await Cart.findOneAndDelete({ _id: id, customerId });
      if (!deletedItem) {
        return res.status(404).json({
          success: false,
          message: "Cart item not found",
          result: {},
        });
      }
      return res.status(200).json({
        success: true,
        message: "Cart item removed",
        result: {},
      });
    }

    const cartItem = await Cart.findOneAndUpdate(
      { _id: id, customerId },
      { quantity },
      { new: true, runValidators: true }
    );

    if (!cartItem) {
      return res.status(404).json({
        success: false,
        message: "Cart item not found",
        result: {},
      });
    }

    res.status(200).json({
      success: true,
      message: "Cart item updated",
      result: cartItem,
    });
  } catch (error) {
    console.error("Update cart by id error:", error);
    res.status(error.statusCode || 500).json({
      success: false,
      message: "Failed to update cart item",
      result: { reason: getErrorMessage(error) },
    });
  }
};

/* ================= REMOVE FROM CART ================= */
export const removeFromCart = async (req, res) => {
  try {
    ensureCustomer(req);
    const { id } = req.params;
    const customerId = req.user.userId;

    const cartItem = await Cart.findOneAndDelete({ _id: id, customerId });

    if (!cartItem) {
      return res.status(404).json({
        success: false,
        message: "Cart item not found",
        result: {},
      });
    }

    res.status(200).json({
      success: true,
      message: "Item removed from cart",
      result: {},
    });
  } catch (error) {
    console.error("Remove from cart error:", error);
    res.status(error.statusCode || 500).json({
      success: false,
      message: "Failed to remove item from cart",
      result: { reason: getErrorMessage(error) },
    });
  }
};

/* ================= CHECKOUT (WITH TRANSACTION & VALIDATION) ================= */
export const checkout = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    ensureCustomer(req);
    const customerId = req.user.userId;

    // Optional safety: ensure user still exists
    if (!req.user) {
      await session.abortTransaction();
      return res.status(404).json({
        success: false,
        message: "User not found",
        result: {},
      });
    }
    // Check for required user fields - REMOVED to allow ad-hoc checkout with provided name/phone
    // Logical validation happens later with derivedName/derivedPhone

    const addressId = normalizeAddressId(req.body?.addressId);
    const scheduledAt = req.body?.scheduledAt;

    // Check for nested address object (Frontend sends this)
    const addressPayload = req.body?.address || req.body || {};

    const addressLineInput = typeof addressPayload.addressLine === "string" ? addressPayload.addressLine.trim() : "";
    const cityInput = typeof addressPayload.city === "string" ? addressPayload.city.trim() : undefined;
    const stateInput = typeof addressPayload.state === "string" ? addressPayload.state.trim() : undefined;
    const pincodeInput = typeof addressPayload.pincode === "string" ? addressPayload.pincode.trim() : undefined;

    // Support both top-level lat/lng and nested location { latitude, longitude } and address.latitude
    const latInput =
      toFiniteNumber(addressPayload.latitude) ??
      toFiniteNumber(addressPayload.location?.latitude) ??
      toFiniteNumber(req.body?.latitude);

    const lngInput =
      toFiniteNumber(addressPayload.longitude) ??
      toFiniteNumber(addressPayload.location?.longitude) ??
      toFiniteNumber(req.body?.longitude);

    // Validate address provided
    const hasCoords = latInput !== null && lngInput !== null;
    const hasAnyAddressInput = Boolean(addressId) || Boolean(addressLineInput) || hasCoords;
    if (!hasAnyAddressInput) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: "Provide either addressId or addressLine or latitude/longitude",
        result: {},
      });
    }

    // Use scheduledAt if provided, otherwise schedule for 1 hour from now
    const finalScheduledAt = scheduledAt ? new Date(scheduledAt) : new Date(Date.now() + 60 * 60 * 1000);

    // 🔁 Decision Logic: Address ID vs Current Location
    let resolvedLocation;
    try {
      resolvedLocation = await resolveUserLocation({
        locationType: req.body.locationType,
        addressId: req.body.addressId,
        latitude: req.body.latitude,
        longitude: req.body.longitude,
        userId: customerId,
      });
    } catch (locErr) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: locErr.message,
        result: {},
      });
    }

    // Address Snapshot for both Products and Services
    const addressSnapshot = resolvedLocation.addressSnapshot;

    // Legacy support: ensure some address text exists
    if (!addressSnapshot.addressLine) {
      addressSnapshot.addressLine = "Pinned Location";
    }

    // Validate that name and phone exist (required for booking)
    if (!addressSnapshot.name || !addressSnapshot.phone) {
      // Fetch user profile as fallback if name/phone still missing
      const userProfile = await User.findById(customerId).select("fname lname mobileNumber").session(session);

      if (!addressSnapshot.name && userProfile) {
        addressSnapshot.name = [userProfile.fname, userProfile.lname].filter(Boolean).join(" ").trim();
      }

      if (!addressSnapshot.phone && userProfile?.mobileNumber) {
        addressSnapshot.phone = userProfile.mobileNumber;
      }

      // Final validation: name and phone MUST exist for booking
      if (!addressSnapshot.name || !addressSnapshot.phone) {
        const error = new Error("Complete profile with name and phone required for booking");
        error.statusCode = 400;
        throw error;
      }
    }

    // Get all cart items for the user
    const cartItems = await Cart.find({ customerId }).session(session);

    if (cartItems.length === 0) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: "Cart is empty",
        result: {},
      });
    }

    // 🔒 VALIDATE: Remove deleted/inactive items and check for price changes
    const validServiceItems = [];
    const validProductItems = [];
    const removedItems = [];

    for (const cartItem of cartItems) {
      if (cartItem.itemType === "service") {
        const service = await Service.findById(cartItem.itemId).session(session);
        if (!service || !service.isActive) {
          await Cart.findByIdAndDelete({ _id: cartItem._id, customerId }).session(session);
          removedItems.push({ id: cartItem.itemId, type: "service", reason: "not found or inactive" });
        } else {
          validServiceItems.push(cartItem);
        }
      } else if (cartItem.itemType === "product") {
        const product = await Product.findById(cartItem.itemId).session(session);
        if (!product || !product.isActive) {
          await Cart.findByIdAndDelete({ _id: cartItem._id, customerId }).session(session);
          removedItems.push({ id: cartItem.itemId, type: "product", reason: "not found or inactive" });
        } else {
          validProductItems.push(cartItem);
        }
      }
    }

    // 🔒 Block checkout if items were removed
    if (removedItems.length > 0) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: "Some items in your cart are no longer available",
        result: { removedItems },
      });
    }

    if (validServiceItems.length === 0 && validProductItems.length === 0) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: "No valid items in cart",
        result: {},
      });
    }

    const bookingResults = {
      address: {
        _id: addressSnapshot._id,
        name: addressSnapshot.name,
        phone: addressSnapshot.phone,
        addressLine: addressSnapshot.addressLine,
        city: addressSnapshot.city,
        state: addressSnapshot.state,
        pincode: addressSnapshot.pincode,
        latitude: addressSnapshot.latitude,
        longitude: addressSnapshot.longitude,
      },
      serviceBookings: [],
      productBookings: [],
      totalAmount: 0,
    };

    const serviceBroadcastTasks = [];

    // Create Service Bookings
    for (const cartItem of validServiceItems) {
      const service = await Service.findById(cartItem.itemId).session(session);

      // Calculate amount
      const baseAmount = service.serviceCost * cartItem.quantity;

      const hasCoordsForBooking =
        typeof addressSnapshot?.latitude === "number" &&
        Number.isFinite(addressSnapshot.latitude) &&
        typeof addressSnapshot?.longitude === "number" &&
        Number.isFinite(addressSnapshot.longitude);

      const serviceBookingDoc = {
        customerId,
        serviceId: cartItem.itemId,
        baseAmount,
        address: addressSnapshot.addressLine, // Legacy field
        addressId: resolvedLocation.addressId || null,
        scheduledAt: finalScheduledAt,
        status: SERVICE_BOOKING_STATUS.REQUESTED,

        // Swiggy-Style Fields
        locationType: resolvedLocation.locationType,
        addressSnapshot: addressSnapshot,
      };

      // GeoJSON Location
      serviceBookingDoc.location = {
        type: "Point",
        coordinates: [resolvedLocation.longitude, resolvedLocation.latitude],
      };

      const serviceBooking = await ServiceBooking.create([serviceBookingDoc], { session });

      // Queue for post-transaction broadcast
      serviceBroadcastTasks.push({
        bookingId: serviceBooking[0]._id,
      });

      bookingResults.serviceBookings.push({
        bookingId: serviceBooking[0]._id,
        serviceId: cartItem.itemId,
        serviceName: service.serviceName,
        quantity: cartItem.quantity,
        baseAmount,
        status: SERVICE_BOOKING_STATUS.REQUESTED,
      });

      bookingResults.totalAmount += baseAmount;
    }

    // Create Product Bookings
    for (const cartItem of validProductItems) {
      const product = await Product.findById(cartItem.itemId).session(session);

      // Calculate amount with discount and GST
      const basePrice = product.productPrice * cartItem.quantity;
      const discountAmount =
        (basePrice * (product.productDiscountPercentage || 0)) / 100;
      const discountedPrice = basePrice - discountAmount;
      const gstAmount = (discountedPrice * (product.productGst || 0)) / 100;
      const finalAmount = discountedPrice + gstAmount;

      const productBooking = await ProductBooking.create([{
        productId: cartItem.itemId,
        customerId,
        amount: finalAmount,
        paymentStatus: PAYMENT_STATUS.PENDING,
        status: PRODUCT_BOOKING_STATUS.ACTIVE,

        // Swiggy-Style Fields
        locationType: resolvedLocation.locationType,
        addressSnapshot: addressSnapshot,
        location: {
          type: "Point",
          coordinates: [resolvedLocation.longitude, resolvedLocation.latitude],
        }
      }], { session });

      bookingResults.productBookings.push({
        bookingId: productBooking[0]._id,
        productId: cartItem.itemId,
        productName: product.productName,
        quantity: cartItem.quantity,
        basePrice,
        discount: discountAmount,
        gst: gstAmount,
        finalAmount,
        paymentStatus: PAYMENT_STATUS.PENDING,
      });

      bookingResults.totalAmount += finalAmount;
    }

    // Clear the cart only after all bookings are created successfully
    await Cart.deleteMany({ customerId }).session(session);

    await session.commitTransaction();

    // 7️⃣ Post-Transaction: Broadcast Jobs (Safe & Smart)
    // We do this OUTSIDE the transaction because it involves heavy logic/sockets
    if (serviceBroadcastTasks.length > 0) {
      // Run in background (fire & forget) or await if you want to report status
      (async () => {
        for (const task of serviceBroadcastTasks) {
          await matchAndBroadcastBooking(task.bookingId, req.io);
        }
      })();
    }

    return res.status(200).json({
      success: true,
      message: "Order placed successfully",
      result: bookingResults,
    });
  } catch (error) {
    await session.abortTransaction();
    console.error("Checkout error:", error);
    const statusCode = error.code === 11000 ? 400 : (error?.statusCode || 500);
    res.status(statusCode).json({
      success: false,
      message: "Checkout failed",
      result: { reason: getErrorMessage(error) },
    });
  } finally {
    session.endSession();
  }
};
