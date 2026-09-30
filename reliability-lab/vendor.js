'use strict';

// vendor.js — stand-in for an outside AI service that writes order confirmation
// messages. We own this fake because in real life you cannot make a real vendor
// fail on command; tonight, this one can.
//
// Mode comes from the VENDOR_MODE environment variable, default "ok":
//   ok      -> after ~50ms, resolve with a correct confirmation message
//   slow    -> hang for 10s, then resolve with the correct message
//   down    -> reject with a 500-style error after a short delay
//   garbage -> resolve quickly with a confidently wrong message

function getMode() {
  return process.env.VENDOR_MODE || 'ok';
}

function goodMessage(orderId) {
  return `Your order ${orderId} is confirmed and will ship within 2 days.`;
}

function garbageMessage(orderId) {
  // Wrong order number, or an AI-disclaimer style non-answer. Alternate so
  // repeated calls exercise both shapes of "confidently wrong".
  const wrongOrderId = `${orderId}-WRONG`;
  const variants = [
    `Your order ${wrongOrderId} is confirmed and will ship within 2 days.`,
    `As an AI I cannot confirm order details at this time.`,
  ];
  return variants[Math.floor(Math.random() * variants.length)];
}

/**
 * Ask the vendor to confirm an order.
 * @param {string} orderId
 * @returns {Promise<string>} the vendor's message
 */
function requestConfirmation(orderId) {
  const mode = getMode();

  return new Promise((resolve, reject) => {
    if (mode === 'ok') {
      setTimeout(() => resolve(goodMessage(orderId)), 50);
      return;
    }

    if (mode === 'slow') {
      setTimeout(() => resolve(goodMessage(orderId)), 10000);
      return;
    }

    if (mode === 'down') {
      setTimeout(() => {
        const err = new Error('Vendor returned 500 Internal Server Error');
        err.name = 'UpstreamUnavailable';
        err.statusCode = 500;
        reject(err);
      }, 50);
      return;
    }

    if (mode === 'garbage') {
      setTimeout(() => resolve(garbageMessage(orderId)), 50);
      return;
    }

    reject(new Error(`Unknown VENDOR_MODE: "${mode}"`));
  });
}

module.exports = { requestConfirmation, getMode };
