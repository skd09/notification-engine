// ── Notification Channels ───────────────────────────────────────
// Extracted from index.ts so the Worker can import them too.
// Each channel simulates the latency.

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export async function sendEmail(userId: number, subject: String, body: String): Promise<void> {
    console.log(`Sending email to user ${userId}: ${subject}`);
    await sleep(2000 + Math.random() * 1000); // Simulate 2-3 seconds latency
    console.log(`Email sent to user ${userId}`);
}

export async function sendSMS(userId: string, message: String): Promise<void> {
    console.log(`Sending SMS to user ${userId}: ${message}`);
    await sleep(1000 + Math.random() * 500); // Simulate 1-1.5 seconds latency
    console.log(`SMS sent to user ${userId}`);
}

export async function sendPush(userId: string, title: String, message: String): Promise<void> {
    console.log(`Sending push notification to user ${userId}: ${title} - ${message}`);
    await sleep(500 + Math.random() * 500); // Simulate 0.5-1 second latency
    console.log(`Push notification sent to user ${userId}`);
}