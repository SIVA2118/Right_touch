import mongoose from "mongoose";

const userSchema = new mongoose.Schema(
  {
    role: {
      type: String,
      enum: ["Customer", "Technician", "Owner", "Admin"],
      required: true,
      index: true,
    },

    // Optional email (unique if present)
    email: {
      type: String,
      trim: true,
      lowercase: true,
      unique: true,
      sparse: true,
      match: [/^\S+@\S+\.\S+$/, "Invalid email"],
    },

    
    fname: {
      type: String,
      trim: true,
    },

    lname: {
      type: String,
      trim: true,
    },

    gender: {
      type: String,
      enum: ["Male", "Female", "Other"],
    },

    mobileNumber: {
      type: String,
      unique: true,
      required: true,
      match: [/^[0-9]{10}$/, "Invalid mobile number"],
    },

    password: {
      type: String,
      required: false, // OTP-only flow
      select: false,
    },

    status: {
      type: String,
      enum: ["Active", "Inactive", "Blocked"],
      default: "Active",
    },

    lastLoginAt: Date,
  },
  { timestamps: true }
);

export default mongoose.models.User ||
  mongoose.model("User", userSchema);
