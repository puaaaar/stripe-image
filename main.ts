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

// Convert image data to ArrayBuffer for response
async function getImageBuffer(imageData: any): Promise<ArrayBuffer> {
  if (imageData.url) {
    // Fetch from URL
    const response = await fetch(imageData.url);
    if (!response.ok) throw new Error("Failed to fetch image");
    return await response.arrayBuffer();
  } else if (imageData.b64_json) {
    // Convert base64 to ArrayBuffer
    const binaryString = atob(imageData.b64_json);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
  } else {
    throw new Error("No image data found");
  }
}

function generatePaymentRequiredMarkdown(
  user: any,
  paymentLink: string
): string {
  return `# 💳 Payment Required

**User:** ${user?.email || "Unknown"}  
**Balance:** $${(user?.balance || 0) / 100}

[**Pay Now →**](${paymentLink})

---

*You need to add funds to your account to generate images.*`;
}

export default {
  fetch: withStripeflare<StripeUser>(async (request, env, ctx) => {
    const t = Date.now();

    // Check if user is registered and has balance
    if (!ctx.registered || ctx.user.balance <= 0) {
      const markdownContent = generatePaymentRequiredMarkdown(
        ctx.user,
        ctx.paymentLink
      );
      return new Response(markdownContent, {
        status: 402,
        headers: {
          "Content-Type": "text/markdown",
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
      const format = url.searchParams.get("format") || "image"; // New parameter to choose response format

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

      // Validate parameters
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

      // For image response format, only allow n=1
      if (format === "image" && n > 1) {
        const markdown = `# Invalid Request

**User:** ${ctx.user.email}  
**Balance:** $${ctx.user.balance / 100}

**Error:** When format=image, only n=1 is supported. Use format=markdown for multiple images.
`;
        return new Response(markdown, {
          status: 400,
          headers: { "Content-Type": "text/markdown" },
        });
      }

      // Calculate cost based on image parameters
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
            model: "dall-e-3", // Updated to use DALL-E 3
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
**Details:** 
\`\`\`json
${JSON.stringify(errorData, null, 2)}
\`\`\`

**Processing Time:** ${speed}ms

> **Note:** You were charged $${totalCostInCents / 100} for this request.
`;
        return new Response(markdown, {
          status: openaiResponse.status,
          headers: { "Content-Type": "text/markdown" },
        });
      }

      const imageData = (await openaiResponse.json()) as any;

      // If format is "image", return the first image directly
      if (format === "image") {
        try {
          const firstImage = imageData.data[0];
          const imageBuffer = await getImageBuffer(firstImage);

          // Save to R2 in the background (don't await)
          const filename = generateImageFilename(
            ctx.user.client_reference_id,
            prompt,
            0
          );
          saveImageToR2(env, imageBuffer, filename, false).catch((error) => {
            console.error("Background save to R2 failed:", error);
          });

          // Return the image directly
          return new Response(imageBuffer, {
            status: 200,
            headers: {
              "Content-Type": "image/png",
              "Content-Disposition": `inline; filename="${filename}"`,
              "Access-Control-Allow-Origin": "*",
              "Access-Control-Allow-Methods": "GET",
              "Access-Control-Allow-Headers": "Content-Type",
              "Cache-Control": "public, max-age=3600", // Cache for 1 hour
            },
          });
        } catch (error) {
          console.error("Failed to process image:", error);
          const markdown = `# Image Processing Failed

**User:** ${ctx.user.email}  
**Balance:** $${(ctx.user.balance - totalCostInCents) / 100} (after charge)

**Error:** Failed to process generated image  
**Message:** ${error instanceof Error ? error.message : "Unknown error"}

> **Note:** You were charged $${totalCostInCents / 100} for this request.
`;
          return new Response(markdown, {
            status: 500,
            headers: { "Content-Type": "text/markdown" },
          });
        }
      }

      // Original markdown response for multiple images or when format=markdown
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

      // Generate markdown content with saved URLs and image rendering
      let imagesMarkdown = "";
      savedImageUrls.forEach((imageUrl: string, index: number) => {
        imagesMarkdown += `
### Image ${index + 1}

![Generated Image ${index + 1}](${imageUrl})

**Direct Link:** [🔗 ${imageUrl}](${imageUrl})

---
`;
      });

      const markdownContent = `# 🎨 Image Generation Complete

✅ **Successfully generated and saved ${savedImageUrls.length} image${
        savedImageUrls.length > 1 ? "s" : ""
      }**

## 📊 Generation Details

**👤 User:** ${ctx.user.email}  
**💰 Balance:** $${(ctx.user.balance - totalCostInCents) / 100} (after charge)  
**💸 Cost:** $${totalCostInCents / 100}  
**⏱️ Processing Time:** ${speed}ms

## 📝 Prompt

> *"${prompt}"*

## ⚙️ Settings

| Setting | Value |
|---------|-------|
| **Size** | ${size} |
| **Quality** | ${quality} |
| **Count** | ${n} |

## 🖼️ Generated Images

${imagesMarkdown}

## 💾 Storage Info

Your images are permanently stored and accessible via the direct links above. Images are cached for optimal performance and availability.

## 💡 Tip

Add \`?format=image\` to your URL to get the image directly instead of this markdown response (only works with n=1).`;

      return new Response(markdownContent, {
        status: 200,
        headers: {
          "Content-Type": "text/markdown",
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
