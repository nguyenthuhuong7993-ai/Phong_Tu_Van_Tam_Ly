export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Keep the existing website available as static assets.
    if (request.method === "GET" || request.method === "HEAD") {
      if (env.ASSETS) return env.ASSETS.fetch(request);
      return new Response("Static asset binding ASSETS is not configured.", { status: 500 });
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    // The current frontend sends POST requests to the Worker root.
    if (request.method !== "POST") {
      return json({ error: "Method not allowed. Use POST for chat." }, 405, request);
    }

    if (!env.OPENAI_API_KEY) {
      return json({ error: "Worker chưa được cấu hình secret OPENAI_API_KEY." }, 500, request);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Dữ liệu gửi lên không phải JSON hợp lệ." }, 400, request);
    }

    const userText = String(body.message || body.input || "").trim();
    if (!userText) return json({ error: "Vui lòng nhập nội dung cần tư vấn." }, 400, request);
    if (userText.length > 12000) return json({ error: "Nội dung quá dài. Em hãy rút gọn rồi thử lại." }, 413, request);

    const history = Array.isArray(body.history) ? body.history : (Array.isArray(body.messages) ? body.messages : []);
    const safeHistory = history.slice(-12).map(item => {
      const role = item && item.role === "assistant" ? "assistant" : "user";
      return { role, content: String(item && item.content || "").slice(0, 6000) };
    }).filter(item => item.content);

    const context = Array.isArray(body.knowledgeContext) ? body.knowledgeContext.slice(0, 8) : [];
    const contextText = context.map((item, i) => {
      const q = String(item.question || "").slice(0, 500);
      const a = String(item.answer || "").slice(0, 1800);
      return `${i + 1}. Câu hỏi gần nghĩa: ${q}\nGợi ý kiến thức: ${a}`;
    }).join("\n\n");

    const systemPrompt = [
      "Bạn là Cô Hường, giáo viên tư vấn tâm lý học đường cho học sinh THCS tại Việt Nam.",
      "Trả lời bằng tiếng Việt tự nhiên, ấm áp, tôn trọng, không phán xét và phù hợp lứa tuổi.",
      "Lắng nghe trước, trả lời đúng trọng tâm, đưa ra 2-4 bước nhỏ, thực tế; khi thiếu dữ kiện quan trọng hãy hỏi một câu làm rõ.",
      "Không chẩn đoán bệnh, không khẳng định cảm xúc chỉ từ khuôn mặt, không bịa thông tin, không hứa giữ bí mật tuyệt đối.",
      "Nếu học sinh có nguy cơ bị tổn thương hoặc không an toàn, khuyến khích em tìm ngay người lớn đáng tin cậy/giáo viên tư vấn để được hỗ trợ trực tiếp.",
      "Kho kiến thức sau đây chỉ là tài liệu tham khảo, hãy chọn phần phù hợp về ý nghĩa, không sao chép máy móc:",
      contextText || "(Không có mục kiến thức cục bộ phù hợp được cung cấp.)",
      String(body.responseGuidance || "").slice(0, 1500)
    ].join("\n\n");

    try {
      const aiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          temperature: 0.5,
          max_tokens: 700,
          messages: [
            { role: "system", content: systemPrompt },
            ...safeHistory,
            { role: "user", content: userText }
          ]
        })
      });

      const raw = await aiResponse.text();
      let result;
      try { result = JSON.parse(raw); } catch { result = {}; }

      if (!aiResponse.ok) {
        // Do not return provider response details that might reveal sensitive configuration.
        const status = aiResponse.status === 401 || aiResponse.status === 403 ? 502 : 502;
        return json({
          error: aiResponse.status === 401 || aiResponse.status === 403
            ? "OpenAI không chấp nhận API key. Hãy kiểm tra secret OPENAI_API_KEY trong Cloudflare."
            : aiResponse.status === 429
              ? "AI đang quá tải hoặc đã hết hạn mức. Em có thể thử lại sau."
              : "Dịch vụ AI chưa xử lý được yêu cầu. Em hãy thử lại sau."
        }, status, request);
      }

      const reply = result.choices && result.choices[0] &&
        result.choices[0].message && result.choices[0].message.content;
      if (!reply || !String(reply).trim()) {
        return json({ error: "AI đã phản hồi nhưng chưa có nội dung trả lời." }, 502, request);
      }
      return json({ reply: String(reply).trim() }, 200, request);
    } catch (error) {
      return json({ error: "Không kết nối được dịch vụ AI. Em hãy thử lại sau." }, 502, request);
    }
  }
};

function corsHeaders(request) {
  const origin = request.headers.get("Origin") || "";
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  };
  // Same-origin site requests are supported. For a different origin, reflect only HTTPS origins.
  if (origin.startsWith("https://")) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function json(data, status, request) {
  return new Response(JSON.stringify(data), { status, headers: corsHeaders(request) });
}
