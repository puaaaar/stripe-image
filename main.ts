import { withStripeflare, StripeUser, DORM } from "stripeflare";
export { DORM };

// Separate HTML generation function
function generatePaymentRequiredHtml(user: any, paymentLink: string): string {
  return `
<!DOCTYPE html>
<html>
<head>
  <title>Payment Required</title>
</head>
<body>
  <h1>💳 Payment Required</h1>
  <p><strong>User:</strong> ${user?.name || "Unknown"}</p>
  <p><strong>Balance:</strong> ${(user?.balance || 0) / 100}</p>
  <p><a href="${paymentLink}">Pay Now</a></p>
</body>
</html>`;
}

function generateSuccessHtml(
  user: any,
  prompt: string,
  imageData: any,
  costInCents: number,
  speed: number,
  size: string,
  quality: string,
  n: number
): string {
  let imagesHtml = "";
  imageData.data.forEach((image: any, index: number) => {
    let imageSource;
    if (image.url) {
      imageSource = image.url;
    } else if (image.b64_json) {
      imageSource = `data:image/png;base64,${image.b64_json}`;
    } else {
      imageSource = "";
    }

    if (imageSource) {
      imagesHtml += `
    <div>
      <p>Image ${index + 1}</p>
      <img src="${imageSource}" alt="Generated Image ${index + 1}" />
    </div>`;
    }
  });

  return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Image Generation Result</title>
</head>
<body>
    <div>
        <div>
            <h1>🎨 Image Generation Complete</h1>
        </div>
        
        <div>
            ✅ Successfully generated ${imageData.data.length} image${
    imageData.data.length > 1 ? "s" : ""
  }
        </div>
        
        <div>
            <strong>👤 User:</strong> ${user.name}<br>
            <strong>💰 Balance:</strong> ${
              (user.balance - costInCents) / 100
            } (after charge)<br>
            <strong>💸 Cost:</strong> ${costInCents / 100}<br>
            <strong>⏱️ Processing Time:</strong> ${speed}ms
        </div>
        
        <div>
            <h3>📝 Prompt</h3>
            <p><em>"${prompt}"</em></p>
        </div>
        
        <h3>⚙️ Settings</h3>
        <div>
            <div>
                <strong>Size</strong><br>${size}
            </div>
            <div>
                <strong>Quality</strong><br>${quality}
            </div>
            <div>
                <strong>Count</strong><br>${n}
            </div>
        </div>
        
        <div>
            <h3>🖼️ Generated Images</h3>
            ${imagesHtml}
        </div>
    </div>
</body>
</html>`;
}

export default {
  fetch: withStripeflare<StripeUser>(async (request, env, ctx) => {
    const t = Date.now();

    // Check if user is registered and has balance
    if (!ctx.registered || ctx.user.balance <= 0) {
      const htmlContent = generatePaymentRequiredHtml(
        ctx.user,
        ctx.paymentLink
      );
      return new Response(htmlContent, {
        status: 402,
        headers: {
          "Content-Type": "text/html",
          Location: ctx.paymentLink,
        },
      });
    }

    // Only handle GET requests for image generation
    if (request.method !== "GET") {
      const markdown = `# Method Not Allowed

**User:** ${ctx.user.name}  
**Balance:** $${ctx.user.balance / 100}

Use GET method to generate images.
`;
      return new Response(markdown, {
        status: 405,
        headers: {
          "Content-Type": "text/markdown",
          Allow: "GET",
        },
      });
    }

    try {
      // Parse query parameters to get image prompt and settings
      const url = new URL(request.url);
      const prompt = url.searchParams.get("prompt");
      const size = url.searchParams.get("size") || "1024x1024";
      const quality = url.searchParams.get("quality") || "low";
      const nParam = url.searchParams.get("n");
      const n = nParam ? parseInt(nParam, 10) : 1;

      if (!prompt || typeof prompt !== "string") {
        const markdown = `# Invalid Request

**User:** ${ctx.user.name}  
**Balance:** $${ctx.user.balance / 100}

**Error:** Missing or invalid required query parameter: prompt
`;
        return new Response(markdown, {
          status: 400,
          headers: { "Content-Type": "text/markdown" },
        });
      }

      // Validate other parameters
      if (
        typeof size !== "string" ||
        !["256x256", "512x512", "1024x1024", "1024x1792", "1792x1024"].includes(
          size
        )
      ) {
        const markdown = `# Invalid Request

**User:** ${ctx.user.name}  
**Balance:** $${ctx.user.balance / 100}

**Error:** Invalid size. Must be one of: 256x256, 512x512, 1024x1024, 1024x1792, 1792x1024
`;
        return new Response(markdown, {
          status: 400,
          headers: { "Content-Type": "text/markdown" },
        });
      }

      if (
        typeof quality !== "string" ||
        !["low", "medium", "high", "auto"].includes(quality)
      ) {
        const markdown = `# Invalid Request

**User:** ${ctx.user.name}  
**Balance:** $${ctx.user.balance / 100}

**Error:** Invalid quality. Must be "low", "medium", "high", or "auto"
`;
        return new Response(markdown, {
          status: 400,
          headers: { "Content-Type": "text/markdown" },
        });
      }

      if (isNaN(n) || n < 1 || n > 4) {
        const markdown = `# Invalid Request

**User:** ${ctx.user.name}  
**Balance:** $${ctx.user.balance / 100}

**Error:** Invalid n. Must be a number between 1 and 4
`;
        return new Response(markdown, {
          status: 400,
          headers: { "Content-Type": "text/markdown" },
        });
      }

      // Calculate cost based on image parameters
      // OpenAI pricing: HD 1024x1024 = $0.040, Standard 1024x1024 = $0.020
      let costInCents;
      if (quality === "high" || quality === "auto") {
        costInCents = 4 * n; // 4 cents per HD image
      } else {
        costInCents = 2 * n; // 2 cents per standard image
      }

      console.log({ user: ctx.user, prompt, costInCents });

      // Charge the user before making the API call
      const { charged, message } = await ctx.charge(costInCents, false);

      if (!charged) {
        const speed = Date.now() - t;
        const markdown = `# Payment Failed

**User:** ${ctx.user.name}  
**Balance:** $${ctx.user.balance / 100}

**Error:** Could not charge user  
**Message:** ${message}  
**Processing Time:** ${speed}ms
`;
        return new Response(markdown, {
          status: 402,
          headers: { "Content-Type": "text/markdown" },
        });
      }

      // Make request to OpenAI API
      const openaiResponse = await fetch(
        "https://api.openai.com/v1/images/generations",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${(env as any).OPENAI_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "gpt-image-1",
            prompt: prompt,
            n: n,
            size: size,
            quality: quality,
          }),
        }
      );

      const speed = Date.now() - t;

      if (!openaiResponse.ok) {
        const errorData = await openaiResponse.json();

        // If OpenAI API fails, you might want to refund the user
        // This depends on your business logic
        console.error("OpenAI API Error:", errorData);

        const markdown = `# Image Generation Failed

**User:** ${ctx.user.name}  
**Balance:** $${(ctx.user.balance - costInCents) / 100} (after charge)

**Error:** Image generation failed  
**Details:** ${JSON.stringify(errorData, null, 2)}  
**Processing Time:** ${speed}ms

> **Note:** You were charged $${costInCents / 100} for this request.
`;
        return new Response(markdown, {
          status: openaiResponse.status,
          headers: { "Content-Type": "text/markdown" },
        });
      }

      const imageData = (await openaiResponse.json()) as any;

      // Generate HTML content using separated function
      const htmlContent = generateSuccessHtml(
        ctx.user,
        prompt,
        imageData,
        costInCents,
        speed,
        size,
        quality,
        n
      );

      // Return HTML response
      return new Response(htmlContent, {
        status: 200,
        headers: {
          "Content-Type": "text/html",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    } catch (error) {
      const speed = Date.now() - t;
      console.error("Worker Error:", error);

      const markdown = `# Internal Server Error

**User:** ${ctx.user.name}  
**Balance:** $${ctx.user.balance / 100}

**Error:** Internal server error  
**Message:** ${error instanceof Error ? error.message : "Unknown error"}  
**Processing Time:** ${speed}ms
`;

      return new Response(markdown, {
        status: 500,
        headers: { "Content-Type": "text/markdown" },
      });
    }
  }),
};
