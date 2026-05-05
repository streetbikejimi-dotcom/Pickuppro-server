const express = require("express");
const cors = require("cors");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = process.env.PORT || 4000;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

app.use(cors());
app.use(express.json());

// Health check
app.get("/", (req, res) => {
  res.json({ status: "Pick Up Pro server is running" });
});

// Register/Login user
app.post("/auth/signup", async (req, res) => {
  try {
    const { name, email, phone, role, password } = req.body;
    const { data: existing } = await supabase.from("users").select("id").eq("email", email).single();
    if (existing) return res.status(400).json({ error: "Email already registered" });
    const { data, error } = await supabase.from("users").insert([{ name, email, phone, role }]).select().single();
    if (error) throw error;
    res.json({ user: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/auth/login", async (req, res) => {
  try {
    const { email } = req.body;
    const { data, error } = await supabase.from("users").select("*").eq("email", email).single();
    if (error || !data) return res.status(404).json({ error: "User not found" });
    res.json({ user: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Post a job
app.post("/jobs", async (req, res) => {
  try {
    const { customer_id, customer_name, customer_email, item, from_address, to_address, size, price, notes } = req.body;
    const { data, error } = await supabase.from("jobs").insert([{ customer_id, customer_name, customer_email, item, from_address, to_address, size, price, notes, status: "open" }]).select().single();
    if (error) throw error;
    res.json({ job: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all open jobs
app.get("/jobs", async (req, res) => {
  try {
    const { data, error } = await supabase.from("jobs").select("*").eq("status", "open").order("created_at", { ascending: false });
    if (error) throw error;
    res.json({ jobs: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get jobs for a customer
app.get("/jobs/customer/:id", async (req, res) => {
  try {
    const { data, error } = await supabase.from("jobs").select("*").eq("customer_id", req.params.id).order("created_at", { ascending: false });
    if (error) throw error;
    res.json({ jobs: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Accept a job (driver)
app.post("/jobs/:id/accept", async (req, res) => {
  try {
    const { driver_id, driver_name } = req.body;
    const { data, error } = await supabase.from("jobs").update({ status: "driver_accepted", driver_id, driver_name }).eq("id", req.params.id).select().single();
    if (error) throw error;
    res.json({ job: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Complete a job
app.post("/jobs/:id/complete", async (req, res) => {
  try {
    const { data, error } = await supabase.from("jobs").update({ status: "completed" }).eq("id", req.params.id).select().single();
    if (error) throw error;
    res.json({ job: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create payment intent
app.post("/create-payment-intent", async (req, res) => {
  try {
    const { amount, jobId, customerEmail } = req.body;
    const amountInCents = Math.round(amount * 100);
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountInCents,
      currency: "usd",
      metadata: { jobId: jobId || "unknown", customerEmail: customerEmail || "unknown", platform: "PickUpPro" },
      automatic_payment_methods: { enabled: true },
    });
    await supabase.from("payments").insert([{ job_id: jobId, stripe_payment_intent_id: paymentIntent.id, amount, status: "pending" }]);
    res.json({ clientSecret: paymentIntent.client_secret, paymentIntentId: paymentIntent.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Onboard driver
app.post("/onboard-driver", async (req, res) => {
  try {
    const { email, driverId } = req.body;
    const account = await stripe.accounts.create({ type: "express", email, metadata: { driverId: driverId || "unknown" }, capabilities: { transfers: { requested: true } } });
    const accountLink = await stripe.accountLinks.create({ account: account.id, refresh_url: "https://pickuppro.app/driver/reauth", return_url: "https://pickuppro.app/driver/onboarded", type: "account_onboarding" });
    await supabase.from("users").update({ stripe_account_id: account.id }).eq("id", driverId);
    res.json({ stripeAccountId: account.id, onboardingUrl: accountLink.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Payout driver
app.post("/payout-driver", async (req, res) => {
  try {
    const { jobPrice, driverAccountId, jobId } = req.body;
    const driverCutCents = Math.round(jobPrice * 0.80 * 100);
    const transfer = await stripe.transfers.create({ amount: driverCutCents, currency: "usd", destination: driverAccountId, metadata: { jobId: jobId || "unknown", platform: "PickUpPro", split: "80% driver / 20% platform" } });
    res.json({ success: true, transferId: transfer.id, driverEarnings: (driverCutCents / 100).toFixed(2), platformFee: (jobPrice * 0.20).toFixed(2) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Driver balance
app.get("/driver-balance/:stripeAccountId", async (req, res) => {
  try {
    const balance = await stripe.balance.retrieve({ stripeAccount: req.params.stripeAccountId });
    const available = balance.available.reduce((sum, b) => sum + b.amount, 0);
    const pending = balance.pending.reduce((sum, b) => sum + b.amount, 0);
    res.json({ available: (available / 100).toFixed(2), pending: (pending / 100).toFixed(2) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Webhook
app.post("/webhook", express.raw({ type: "application/json" }), (req, res) => {
  const sig = req.headers["stripe-signature"];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, secret);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  switch (event.type) {
    case "payment_intent.succeeded":
      const payment = event.data.object;
      supabase.from("payments").update({ status: "succeeded" }).eq("stripe_payment_intent_id", payment.id);
      supabase.from("jobs").update({ status: "paid" }).eq("id", payment.metadata.jobId);
      break;
    case "payment_intent.payment_failed":
      console.log("❌ Payment failed:", event.data.object.id);
      break;
  }
  res.json({ received: true });
});

app.listen(PORT, () => console.log(`Pick Up Pro server running on port ${PORT}`));
