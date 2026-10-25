// CARE AI – Cloudflare Worker kết nối Google Gemini.
// Cloudflare Secret bắt buộc: GEMINI_API_KEY
// Biến tùy chọn: GEMINI_MODEL (mặc định gemini-2.5-flash)

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" || request.method === "HEAD") {
      if (env.ASSETS) return env.ASSETS.fetch(request);
      return new Response("Static asset binding ASSETS is not configured.", { status: 500 });
    }

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(request)
      });
    }

    if (request.method !== "POST") {
      return json(
        { error: "Method not allowed. Use POST for chat." },
        405,
        request
      );
    }

    if (!env.GEMINI_API_KEY) {
      return json({
        error: "Worker chưa được cấu hình secret GEMINI_API_KEY."
      }, 500, request);
    }

    let body;

    try {
      body = await request.json();
    } catch {
      return json({
        error: "Dữ liệu gửi lên không phải JSON hợp lệ."
      }, 400, request);
    }

    const userText = String(
      body.message || body.input || ""
    ).trim();

    if (!userText) {
      return json({
        error: "Vui lòng nhập nội dung cần tư vấn."
      }, 400, request);
    }

    if (userText.length > 12000) {
      return json({
        error: "Nội dung quá dài. Em hãy rút gọn rồi thử lại."
      }, 413, request);
    }

    // Lấy lịch sử hội thoại
    const history = Array.isArray(body.history)
      ? body.history
      : (Array.isArray(body.messages) ? body.messages : []);

    const safeHistory = history.slice(-12).map(item => ({
      role: item &&
        (item.role === "assistant" || item.role === "model")
        ? "model"
        : "user",

      parts: [{
        text: String(
          item && (item.content || item.text) || ""
        ).slice(0, 6000)
      }]
    })).filter(item => item.parts[0].text.trim());

    // Thiết lập vai trò cho CARE AI
    const systemPrompt = [
      "Bạn là CARE AI – Trợ lý AI tư vấn tâm lý học đường dành cho học sinh THCS tại Việt Nam.",

      "Bạn là công cụ hỗ trợ, không phải người thật hoặc chuyên gia trị liệu. Không tự nhận là giáo viên trực tiếp đang trò chuyện.",

      "Trả lời bằng tiếng Việt tự nhiên, ấm áp, tôn trọng, không phán xét và phù hợp lứa tuổi.",

      "Lắng nghe và xác nhận cảm xúc trước; trả lời đúng trọng tâm, ngắn gọn; đưa ra 2–4 gợi ý nhỏ, thực tế. Nếu thiếu dữ kiện quan trọng, hỏi một câu làm rõ.",

      "Không chẩn đoán bệnh, không suy đoán chắc chắn cảm xúc từ khuôn mặt, không bịa thông tin, không hứa giữ bí mật tuyệt đối.",

      "Không yêu cầu học sinh cung cấp tên thật, địa chỉ, số điện thoại, mật khẩu hay thông tin nhận dạng không cần thiết.",

      "Nếu học sinh có dấu hiệu không an toàn, bị bạo lực hoặc cần hỗ trợ khẩn cấp, khuyến khích liên hệ ngay người lớn đáng tin cậy, giáo viên tư vấn hoặc dịch vụ khẩn cấp tại địa phương. Không cung cấp hướng dẫn gây hại.",

      "Khi phù hợp, nhắc rằng học sinh có thể đặt lịch gặp giáo viên tư vấn trực tiếp trong WebApp.",

      String(body.responseGuidance || "").slice(0, 1500)

    ].filter(Boolean).join("\n\n");

    // Chọn mô hình Gemini
    const model = String(
      env.GEMINI_MODEL || "gemini-2.5-flash"
    ).trim();

    if (!/^[a-zA-Z0-9._-]+$/.test(model)) {
      return json({
        error: "Tên GEMINI_MODEL không hợp lệ."
      }, 500, request);
    }

    try {

      // Gửi yêu cầu đến Google Gemini
      const aiResponse = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: "POST",

          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": env.GEMINI_API_KEY
          },

          body: JSON.stringify({

            systemInstruction: {
              parts: [{
                text: systemPrompt
              }]
            },

            contents: [
              ...safeHistory,

              {
                role: "user",
                parts: [{
                  text: userText
                }]
              }
            ],

            generationConfig: {
              temperature: 0.5,
              maxOutputTokens: 1100
            }

          })
        }
      );

      let result;

      try {
        result = await aiResponse.json();
      } catch {
        result = {};
      }

      // Xử lý lỗi Gemini
      if (!aiResponse.ok) {

        const errorMessage =
          aiResponse.status === 401 ||
          aiResponse.status === 403

            ? "Gemini từ chối quyền truy cập. Hãy kiểm tra GEMINI_API_KEY và quyền sử dụng API."

            : aiResponse.status === 404

              ? "Không tìm thấy mô hình Gemini đã cấu hình. Hãy kiểm tra GEMINI_MODEL."

              : aiResponse.status === 429

                ? "Gemini đang quá tải hoặc đã hết hạn mức. Em hãy thử lại sau."

                : "Dịch vụ Gemini chưa xử lý được yêu cầu. Em hãy thử lại sau.";

        return json({
          error: errorMessage
        }, 502, request);
      }

      // Lấy câu trả lời của Gemini
      const reply = (result.candidates || [])
        .flatMap(candidate =>
          candidate.content &&
          candidate.content.parts || []
        )
        .filter(part =>
          typeof part.text === "string"
        )
        .map(part => part.text)
        .join("\n")
        .trim();

      if (!reply) {
        return json({
          error: "Gemini chưa tạo được câu trả lời phù hợp. Em hãy diễn đạt lại câu hỏi."
        }, 502, request);
      }

      // Trả kết quả về WebApp CARE AI
      return json({
        reply: reply
      }, 200, request);

    } catch {

      return json({
        error: "Không kết nối được Gemini. Em hãy thử lại sau."
      }, 502, request);

    }
  }
};


// Cấu hình CORS
function corsHeaders(request) {

  const origin = request.headers.get("Origin") || "";

  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Vary": "Origin",

    "Access-Control-Allow-Methods":
      "GET, HEAD, POST, OPTIONS",

    "Access-Control-Allow-Headers":
      "Content-Type, Authorization"
  };

  if (origin.startsWith("https://")) {
    headers["Access-Control-Allow-Origin"] = origin;
  }

  return headers;
}


// Trả dữ liệu JSON
function json(data, status, request) {

  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: corsHeaders(request)
    }
  );

}
