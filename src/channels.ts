// ── Notification Channels ───────────────────────────────────────
// Extracted from index.ts so the Worker can import them too.
// Each channel simulates the latency.

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Simulate failures ~30% of the time so you can see retry + DLQ in action
const FAILURE_RATE = 0.3;

function shouldFail(): boolean {
    return Math.random() < FAILURE_RATE;
}

export async function sendEmail(userId: number, subject: String, body: String): Promise<void> {
    console.log(`Sending email to user ${userId}: ${subject}`);
    await sleep(2000 + Math.random() * 1000); // Simulate 2-3 seconds latency

    if (shouldFail()) {
        throw new Error(`SMTP connection timed out`);
    }

    console.log(`Email sent to user ${userId}`);
}

export async function sendSMS(userId: string, message: String): Promise<void> {
    console.log(`Sending SMS to user ${userId}: ${message}`);
    await sleep(1000 + Math.random() * 500); // Simulate 1-1.5 seconds latency

    if (shouldFail()) {
        throw new Error(`Twilio API rate limit exceeded`);
    }

    console.log(`SMS sent to user ${userId}`);
}

export async function sendPush(userId: string, title: String, message: String): Promise<void> {
    console.log(`Sending push notification to user ${userId}: ${title} - ${message}`);
    await sleep(500 + Math.random() * 500); // Simulate 0.5-1 second latency

    if (shouldFail()) {
        throw new Error(`FCM device token expired`);
    }

    console.log(`Push notification sent to user ${userId}`);
}