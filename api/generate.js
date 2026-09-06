
export default async function handler(req, res) {
  try {
    const { topic, mode } = req.body;

    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "openai/gpt-oss-120b",
        messages: [{
          role: "user",
          content: `Create ${mode} topper-style notes on "${topic}" with headings, bullets, diagrams. Keep concise and exam-ready.`
        }]
      })
    });

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content || "Failed";

    const html = `
    <html>
    <head>
    <style>
    body { font-family: Arial; padding: 40px; }
    h1 { color: #2563eb; }
    h2 { color: #16a34a; }
    h3 { color: #dc2626; }
    </style>
    </head>
    <body>${content.replace(/\n/g,"<br>")}</body>
    </html>
    `;

    res.setHeader("Content-Type", "text/html");
    res.status(200).send(html);

  } catch (e) {
    res.status(500).json({ error: "Server error" });
  }
}
