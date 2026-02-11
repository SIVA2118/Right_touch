import mongoose from "mongoose";

const addressSchema = new mongoose.Schema(
  {
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    
    label: {
      type: String,
      enum: ["home", "office", "other"],
      default: "home",
    },

    name: {
      type: String,
      required: false,
      trim: true,
    },

    phone: {
      type: String,
      required: false,
      match: [/^[0-9]{10}$/, "Phone must be 10 digits"],
    },

    addressLine: {
      type: String,
      required: true,
      trim: true,
    },

    city: {
      type: String,
      trim: true,
    },

    state: {
      type: String,
      trim: true,
    },

    pincode: {
      type: String,
      match: [/^[0-9]{6}$/, "Invalid pincode"],
    },

    latitude: {
      type: Number,
      required: false,
      validate: {
        validator: function(v) {
          // Both must exist or both must be null
          const hasLat = v !== null && v !== undefined;
          const hasLng = this.longitude !== null && this.longitude !== undefined;
          return hasLat === hasLng; // Both true or both false
        },
        message: "Both latitude and longitude must be provided together"
      }
    },

    longitude: {
      type: Number,
      required: false,
      validate: {
        validator: function(v) {
          // Both must exist or both must be null
          const hasLng = v !== null && v !== undefined;
          const hasLat = this.latitude !== null && this.latitude !== undefined;
          return hasLng === hasLat; // Both true or both false
        },
        message: "Both latitude and longitude must be provided together"
      }
    },

    isDefault: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

/**
 * Only ONE default address per user
 */
addressSchema.index(
  { customerId: 1, isDefault: 1 },
  { unique: true, partialFilterExpression: { isDefault: true } }
);

export default mongoose.models.Address ||
  mongoose.model("Address", addressSchema);
