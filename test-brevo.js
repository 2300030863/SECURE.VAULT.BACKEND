const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

async function sendTestEmail() {
  const apiKey = process.env.BREVO_API_KEY?.trim();
  const senderEmail = process.env.BREVO_SENDER_EMAIL?.trim();
  const recipientEmail = process.argv[2] || process.env.BREVO_TEST_RECIPIENT || "";

  if (!apiKey || apiKey === "YOUR_COPIED_API_KEY") {
    console.error("❌ Error: BREVO_API_KEY is not configured in backend/.env.");
    console.log("👉 Please paste your Brevo API key into backend/.env (e.g. BREVO_API_KEY=xkeysib-...)");
    return;
  }

  if (!senderEmail || senderEmail === "your_verified_sender_email") {
    console.error("❌ Error: BREVO_SENDER_EMAIL is not set in backend/.env.");
    console.log("👉 Please set your verified Brevo sender email in backend/.env (e.g. BREVO_SENDER_EMAIL=otp@kommalapatisivesh.me)");
    return;
  }

  console.log(`Sending test email via Brevo...`);
  console.log(`From: DocQevrilo <${senderEmail}>`);
  console.log(`To: ${recipientEmail}`);

  try {
    const response = await fetch(
      "https://api.brevo.com/v3/smtp/email",
      {
        method: "POST",
        headers: {
          "api-key": apiKey,
          "Content-Type": "application/json",
          "Accept": "application/json"
        },
        body: JSON.stringify({
          sender: {
            name: "DocQevrilo",
            email: senderEmail
          },
          to: [
            { email: recipientEmail }
          ],
          subject: "DocQevrilo Email Test",
          htmlContent: "<h2>Brevo email is working!</h2><p>Your local backend successfully sent this test email.</p>"
        })
      }
    );

    const result = await response.json();

    if (!response.ok) {
      console.error("Failed:", result);
      return;
    }

    console.log("Email sent successfully!");
    console.log(result);

  } catch (error) {
    console.error(error.message);
  }
}

sendTestEmail();

