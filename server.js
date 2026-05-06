// ════════════════════════════════════════════════════════
//  PICK UP PRO — Backend Server
//  Host this on Render.com (free tier)
//  Add your Stripe secret key as an environment variable
// ════════════════════════════════════════════════════════

const express = require("express");
const cors    = require("cors");
const stripe  = require("stripe")(process.env.STRIPE_SECRET_KEY);

const app  = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

// ── Health check ─────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "Pick Up Pro server is running 🚛" });
});

// ════════════════════════════════════════════════════════
//  1. CREATE PAYMENT INTENT
//     Called when customer taps "Confirm & Pay"
//     Returns a clientSecret the app uses to charge the card
// ════════════════════════════════════════════════════════
app.post("/create-payment-intent", async (req, res) => {
  try {
    const { amount, currency = "usd", jobId, customerEmail } = req.body;

    // amount comes in as dollars — convert to cents for Stripe
    const amountInCents = Math.round(amount * 100);

    const paymentIntent = await stripe.paymentIntents.create({
      amount:   amountInCents,
      currency: currency,
      metadata: {
        jobId:         jobId || "unknown",
        customerEmail: customerEmail || "unknown",
        platform:      "PickUpPro",
      },
      // Automatically confirm when card details are provided
      automatic_payment_methods: { enabled: true },
    });

    res.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
    });

  } catch (err) {
    console.error("Payment intent error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════
//  2. ONBOARD A DRIVER (Stripe Connect)
//     Creates a Stripe Connect account for the driver
//     Sends them an onboarding link to enter bank details
// ════════════════════════════════════════════════════════
app.post("/onboard-driver", async (req, res) => {
  try {
    const { email, driverId } = req.body;

    // Create a Stripe Connect Express account for the driver
    const account = await stripe.accounts.create({
      type:    "express",
      email:   email,
      metadata: { driverId: driverId || "unknown" },
      capabilities: {
        transfers: { requested: true },
      },
    });

    // Generate an onboarding link (driver fills in their bank details)
    const accountLink = await stripe.accountLinks.create({
      account:     account.id,
      refresh_url: "https://pickuppro.app/driver/reauth",
      return_url:  "https://pickuppro.app/driver/onboarded",
      type:        "account_onboarding",
    });

    res.json({
      stripeAccountId: account.id,
      onboardingUrl:   accountLink.url,
    });

  } catch (err) {
    console.error("Driver onboard error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════
//  3. PAY OUT DRIVER (80/20 Split)
//     Called when a job is marked as delivered
//     Sends 80% to the driver's Stripe Connect account
//     Your 20% stays in your Pick Up Pro Stripe balance
// ════════════════════════════════════════════════════════
app.post("/payout-driver", async (req, res) => {
  try {
    const {
      jobPrice,          // total job price in dollars
      driverAccountId,   // driver's Stripe Connect account ID
      jobId,
    } = req.body;

    // Calculate the 80% driver cut in cents
    const driverCutCents = Math.round(jobPrice * 0.80 * 100);

    // Transfer 80% to the driver's connected account
    const transfer = await stripe.transfers.create({
      amount:      driverCutCents,
      currency:    "usd",
      destination: driverAccountId,
      metadata: {
        jobId:       jobId || "unknown",
        platform:    "PickUpPro",
        split:       "80% driver / 20% platform",
      },
    });

    res.json({
      success:        true,
      transferId:     transfer.id,
      driverEarnings: (driverCutCents / 100).toFixed(2),
      platformFee:    (jobPrice * 0.20).toFixed(2),
    });

  } catch (err) {
    console.error("Payout error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════
//  4. GET DRIVER BALANCE
//     Returns how much a driver has available to withdraw
// ════════════════════════════════════════════════════════
app.get("/driver-balance/:stripeAccountId", async (req, res) => {
  try {
    const { stripeAccountId } = req.params;

    const balance = await stripe.balance.retrieve({
      stripeAccount: stripeAccountId,
    });

    const available = balance.available.reduce((sum, b) => sum + b.amount, 0);
    const pending   = balance.pending.reduce((sum, b) => sum + b.amount, 0);

    res.json({
      available: (available / 100).toFixed(2),
      pending:   (pending / 100).toFixed(2),
    });

  } catch (err) {
    console.error("Balance error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════
//  5. STRIPE WEBHOOK
//     Listens for payment confirmations from Stripe
//     Use this to update job status when payment succeeds
// ════════════════════════════════════════════════════════
app.post("/webhook", express.raw({ type: "application/json" }), (req, res) => {
  const sig     = req.headers["stripe-signature"];
  const secret  = process.env.STRIPE_WEBHOOK_SECRET;
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, secret);
  } catch (err) {
    console.error("Webhook signature failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  switch (event.type) {
    case "payment_intent.succeeded":
      const payment = event.data.object;
      console.log(`✅ Payment succeeded: $${(payment.amount / 100).toFixed(2)} — Job: ${payment.metadata.jobId}`);
      // TODO: Update your database — mark job as paid
      break;

    case "payment_intent.payment_failed":
      console.log(`❌ Payment failed: ${event.data.object.id}`);
      break;

    case "transfer.created":
      console.log(`💸 Driver payout sent: $${(event.data.object.amount / 100).toFixed(2)}`);
      break;

    default:
      console.log(`Unhandled event: ${event.type}`);
  }

  res.json({ received: true });
});

// ── Start server ──────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚛 Pick Up Pro server running on port ${PORT}`);
});
