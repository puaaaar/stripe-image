import { withStripeflare, StripeUser, DORM } from "stripeflare";
export { DORM };

// Generate unique filename
function generateImageFilename(
  userId: string,
  prompt: string,
  index: number = 0
): string {
  const timestamp = Date.now();
  const promptHash = prompt.slice(0, 20).replace(/[^a-zA-Z0-9]/g, "");
  return `images/${userId}/${timestamp}-${promptHash}-${index}.png`;
}

// Save image to Cloudflare R2
async function saveImageToR2(
  env: any,
  imageData: string | ArrayBuffer,
  filename: string,
  isBase64: boolean = false
): Promise<string> {
  try {
    let imageBuffer: ArrayBuffer;

    if (isBase64 && typeof imageData === "string") {
      // Convert base64 to ArrayBuffer
      const binaryString = atob(imageData);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      imageBuffer = bytes.buffer;
    } else if (typeof imageData === "string") {
      // Fetch image from URL
      const response = await fetch(imageData);
      if (!response.ok) throw new Error("Failed to fetch image");
      imageBuffer = await response.arrayBuffer();
    } else {
      imageBuffer = imageData;
    }

    // Upload to R2
    await env.stripeimages.put(filename, imageBuffer, {
      httpMetadata: {
        contentType: "image/png",
        cacheControl: "public, max-age=31536000", // 1 year cache
      },
    });

    // Return public URL using environment variable with fallback
    const isDev = env.ENVIRONMENT === "development";
    const baseUrl = isDev
      ? env.R2_DEV_URL || `https://pub-${env.R2_BUCKET_ID}.r2.dev`
      : env.R2_PUBLIC_URL || "https:///stripeimages.brubslabs.com";
    return `${baseUrl}/${filename}`;
  } catch (error) {
    console.error("Failed to save image to R2:", error);
    throw error;
  }
}

// Enhanced success HTML with saved URLs
function generateSuccessHtml(
  user: any,
  prompt: string,
  savedImageUrls: string[],
  costInCents: number,
  speed: number,
  size: string,
  quality: string,
  n: number
): string {
  let imagesHtml = "";
  savedImageUrls.forEach((imageUrl: string, index: number) => {
    imagesHtml += `
    <div style="margin: 20px 0; text-align: center;">
      <p><strong>Image ${index + 1}</strong></p>
      <img src="${imageUrl}" alt="Generated Image ${
      index + 1
    }" style="max-width: 100%; height: auto; border: 1px solid #ddd; border-radius: 8px;" />
      <br>
      <a href="${imageUrl}" target="_blank" style="color: #0066cc; text-decoration: none;">🔗 Direct Link</a>
    </div>`;
  });

  return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Image Generation Result</title>
    <style>
      body { font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }
      .info-box { background: #f5f5f5; padding: 15px; border-radius: 8px; margin: 15px 0; }
      .settings { display: flex; gap: 20px; flex-wrap: wrap; }
      .setting-item { background: white; padding: 10px; border-radius: 5px; border: 1px solid #ddd; }
    </style>
</head>
<body>
    <div>
        <h1>🎨 Image Generation Complete</h1>
        
        <div class="info-box">
            ✅ Successfully generated and saved ${savedImageUrls.length} image${
    savedImageUrls.length > 1 ? "s" : ""
  }
        </div>
        
        <div class="info-box">
            <strong>👤 User:</strong> ${user.email}<br>
            <strong>💰 Balance:</strong> $${
              (user.balance - costInCents) / 100
            } (after charge)<br>
            <strong>💸 Cost:</strong> $${costInCents / 100}<br>
            <strong>⏱️ Processing Time:</strong> ${speed}ms
        </div>
        
        <div class="info-box">
            <h3>📝 Prompt</h3>
            <p><em>"${prompt}"</em></p>
        </div>
        
        <h3>⚙️ Settings</h3>
        <div class="settings">
            <div class="setting-item">
                <strong>Size</strong><br>${size}
            </div>
            <div class="setting-item">
                <strong>Quality</strong><br>${quality}
            </div>
            <div class="setting-item">
                <strong>Count</strong><br>${n}
            </div>
        </div>
        
        <div>
            <h3>🖼️ Generated Images</h3>
            ${imagesHtml}
        </div>
        
        <div class="info-box" style="background: #e8f5e8;">
            <strong>💾 Images Saved:</strong> Your images are permanently stored and accessible via the direct links above.
        </div>
    </div>
</body>
</html>`;
}

function generatePaymentRequiredHtml(user: any, paymentLink: string): string {
  return `
<!DOCTYPE html>
<html>
<head>
  <title>Payment Required</title>
</head>
<body>
  <h1>💳 Payment Required</h1>
  <p><strong>User:</strong> ${user?.email || "Unknown"}</p>
  <p><strong>Balance:</strong> $${(user?.balance || 0) / 100}</p>
  <p><a href="${paymentLink}">Pay Now</a></p>
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

**User:** ${ctx.user.email}  
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
      // Parse query parameters
      const url = new URL(request.url);
      const prompt = url.searchParams.get("prompt");
      const size = url.searchParams.get("size") || "1024x1024";
      const quality = url.searchParams.get("quality") || "low";
      const nParam = url.searchParams.get("n");
      const n = nParam ? parseInt(nParam, 10) : 1;

      if (!prompt || typeof prompt !== "string") {
        const markdown = `# Invalid Request

**User:** ${ctx.user.email}  
**Balance:** $${ctx.user.balance / 100}

**Error:** Missing or invalid required query parameter: prompt
`;
        return new Response(markdown, {
          status: 400,
          headers: { "Content-Type": "text/markdown" },
        });
      }

      // Validate parameters (same as before)
      if (
        !["256x256", "512x512", "1024x1024", "1024x1792", "1792x1024"].includes(
          size
        )
      ) {
        const markdown = `# Invalid Request

**User:** ${ctx.user.email}  
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

**User:** ${ctx.user.email}  
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

**User:** ${ctx.user.email}  
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

      // Add storage cost (minimal)
      const storageCostInCents = Math.ceil(n * 0.1); // ~0.1 cent per image for storage
      const totalCostInCents = costInCents + storageCostInCents;

      console.log({ user: ctx.user, prompt, totalCostInCents });

      // Charge the user
      const { charged, message } = await ctx.charge(totalCostInCents, false);

      if (!charged) {
        const speed = Date.now() - t;
        const markdown = `# Payment Failed

**User:** ${ctx.user.email}  
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

      if (!openaiResponse.ok) {
        const errorData = await openaiResponse.json();
        console.error("OpenAI API Error:", errorData);

        const speed = Date.now() - t;
        const markdown = `# Image Generation Failed

**User:** ${ctx.user.email}  
**Balance:** $${(ctx.user.balance - totalCostInCents) / 100} (after charge)

**Error:** Image generation failed  
**Details:** ${JSON.stringify(errorData, null, 2)}  
**Processing Time:** ${speed}ms

> **Note:** You were charged $${totalCostInCents / 100} for this request.
`;
        return new Response(markdown, {
          status: openaiResponse.status,
          headers: { "Content-Type": "text/markdown" },
        });
      }

      const imageData = (await openaiResponse.json()) as any;

      // Save images to R2 and get URLs
      const savedImageUrls: string[] = [];

      for (let i = 0; i < imageData.data.length; i++) {
        const image = imageData.data[i];
        const filename = generateImageFilename(
          ctx.user.client_reference_id,
          prompt,
          i
        );

        try {
          let savedUrl: string;

          if (image.url) {
            // Save from URL
            savedUrl = await saveImageToR2(env, image.url, filename, false);
          } else if (image.b64_json) {
            // Save from base64
            savedUrl = await saveImageToR2(env, image.b64_json, filename, true);
          } else {
            throw new Error("No image data found");
          }

          savedImageUrls.push(savedUrl);
        } catch (error) {
          console.error(`Failed to save image ${i}:`, error);
          // Fallback to original URL or base64
          if (image.url) {
            savedImageUrls.push(image.url);
          } else if (image.b64_json) {
            savedImageUrls.push(`data:image/png;base64,${image.b64_json}`);
          }
        }
      }

      const speed = Date.now() - t;

      // Generate HTML content with saved URLs
      const htmlContent = generateSuccessHtml(
        ctx.user,
        prompt,
        savedImageUrls,
        totalCostInCents,
        speed,
        size,
        quality,
        n
      );

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

**User:** ${ctx.user.email}  
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
