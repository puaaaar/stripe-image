import {
  withStripeflare,
  StripeUser,
  DORM,
  Env as StripeflareEnv,
} from "stripeflare";
export { DORM };

type Env = StripeflareEnv & {
  stripeimages: R2Bucket;
  R2_PUBLIC_URL: string | undefined;
  R2_DEV_URL: string | undefined;
  R2_BUCKET_ID: string;
  ENVIRONMENT: string;
};

// Save image to Cloudflare R2
async function saveImageToR2(
  env: Env,
  imageData: string | ArrayBuffer,
  filename: string,
  isBase64: boolean = false
): Promise<string> {
  try {
    let imageBuffer: ArrayBuffer;

    if (isBase64 && typeof imageData === "string") {
      // Strip data URL prefix if present (data:image/png;base64,)
      const base64Data = imageData.replace(/^data:image\/[a-z]+;base64,/, "");

      // Convert base64 to ArrayBuffer
      const binaryString = atob(base64Data);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      imageBuffer = bytes.buffer;
    } else if (typeof imageData === "string") {
      // Fetch image from URL
      const response = await fetch(imageData);
      if (!response.ok)
        throw new Error(`Failed to fetch image: ${response.status}`);
      imageBuffer = await response.arrayBuffer();
    } else {
      imageBuffer = imageData;
    }

    console.log(
      `Uploading to R2: ${filename}, size: ${imageBuffer.byteLength} bytes`
    );

    // Upload to R2
    await env.stripeimages.put(filename, imageBuffer, {
      httpMetadata: {
        contentType: "image/png",
        cacheControl: "public, max-age=31536000", // 1 year cache
      },
    });

    console.log(`Successfully uploaded to R2: ${filename}`);

    // Return public URL using environment variable with fallback
    const isDev = env.ENVIRONMENT === "development";
    const baseUrl = isDev
      ? env.R2_DEV_URL || `https://pub-${env.R2_BUCKET_ID}.r2.dev`
      : env.R2_PUBLIC_URL || "https://imagebucket.brubslabs.com";
    return `${baseUrl}/${filename}`;
  } catch (error) {
    console.error("Failed to save image to R2:", error);
    throw error;
  }
}

// Convert image data to ArrayBuffer for response
async function getImageBuffer(imageData: any): Promise<ArrayBuffer> {
  if (imageData.b64_json) {
    // Strip data URL prefix if present
    const base64Data = imageData.b64_json.replace(
      /^data:image\/[a-z]+;base64,/,
      ""
    );

    // Convert base64 to ArrayBuffer
    const binaryString = atob(base64Data);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
  } else if (imageData.url) {
    // Fetch image from URL
    const response = await fetch(imageData.url);
    if (!response.ok)
      throw new Error(`Failed to fetch image: ${response.status}`);
    return await response.arrayBuffer();
  } else {
    throw new Error("No image data found (neither b64_json nor url)");
  }
}

// Parse URL path to extract parameters
function parseImagePath(
  pathname: string
): { prompt: string; size: string; quality: string } | null {
  // Remove leading slash and split by '/'
  const parts = pathname
    .replace(/^\/+/, "")
    .split("/")
    .filter((part) => part.length > 0);

  // Expected format: image/prompt[/size][/quality]
  // Minimum requirement: image/prompt
  if (parts.length < 2 || parts[0] !== "image") {
    return null;
  }

  // Extract parameters with defaults
  const prompt = parts[1] ? decodeURIComponent(parts[1]) : "";
  const size = parts[2] || "1024x1024";
  const quality = parts[3] || "low";

  if (!prompt) {
    return null;
  }

  return { prompt, size, quality };
}

export default {
  fetch: withStripeflare<StripeUser>(async (request, env: Env, ctx) => {
    const url = new URL(request.url);
    const filename = url.pathname;

    const already = await env.stripeimages.get(filename);
    if (already) {
      return new Response(already.body, {
        headers: {
          "Content-Type": already.httpMetadata?.contentType || "image/png",
          "Content-Disposition": `inline; filename="${filename}"`,
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    console.log("Request received:", ctx.registered, ctx.user.balance);

    // Check if user is registered and has balance
    if (!ctx.registered || ctx.user.balance <= 0) {
      return new Response(null, {
        status: 302,
        headers: {
          Location: ctx.paymentLink,
        },
      });
    }

    // Only handle GET requests for image generation
    if (request.method !== "GET") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: {
          Allow: "GET",
        },
      });
    }

    try {
      // Parse URL path parameters
      const pathParams = parseImagePath(url.pathname);

      if (!pathParams) {
        return new Response(
          `Welcome to image.brubslabs.com!
          
# Use the following format to generate images:

/image/prompt[/size][/quality]

- prompt: any text prompt (required)
- size: 1024x1024 (default), 1024x1536, 1536x1024
- quality: low (default), medium, high, auto

Examples:

- /image/cat
- /image/cat/1024x1024  
- /image/cat/1024x1024/high

# Pricing:

Cost includes: input text tokens + input image tokens + output image tokens

## Output tokens:

| Quality | Square (1024×1024) | Portrait (1024×1536) | Landscape (1536×1024) |
|---------|--------------------|----------------------|-----------------------|
| Low     | $0.011             | $0.016               | $0.016                |
| Medium  | $0.042             | $0.063               | $0.063                |
| High    | $0.167             | $0.25                | $0.25                 |

## Input tokens (per 1M tokens):

| Type             | Input     | Cached input         | Output                |
|------------------|-----------|----------------------|-----------------------|
| Text tokens      | $5.00     | $1.25                | -                     |
| Image tokens     | $10.00    | $2.50                | $40.00                |

### Image tokens calculation:

Scale image so shortest side = 512px
Count 512px tiles needed
Calculate cost: (tiles × 129) + 65 tokens

Examples:

1024×1024 → 512×512 → 1 tile → 194 tokens
2048×4096 → 512×1024 → 2 tiles → 323 tokens`,
          {
            status: 400,
          }
        );
      }

      const { prompt, size, quality } = pathParams;

      console.log("Parsed parameters:", { prompt, size, quality });

      // Calculate cost based on image parameters
      let costInCents;
      if (quality === "high" || quality === "auto" || quality === "medium") {
        costInCents = 4;
      } else {
        costInCents = 2;
      }

      // Add storage cost (minimal)
      const storageCostInCents = Math.ceil(1 * 0.1); // ~0.1 cent per image for storage
      const totalCostInCents = costInCents + storageCostInCents;

      console.log({ user: ctx.user, prompt, totalCostInCents });

      // Charge the user
      const { charged, message } = await ctx.charge(totalCostInCents, false);

      if (!charged) {
        return new Response(`Payment failed: ${message}`, {
          status: 402,
        });
      }

      const headers = {
        Authorization: `Bearer ${(env as any).OPENAI_API_KEY}`,
        "Content-Type": "application/json",
        "User-Agent": "StripeImages/1.0",
        Accept: "application/json",
      };
      // Make request to OpenAI API
      const openaiResponse = await fetch(
        "https://api.openai.com/v1/images/generations",
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: "gpt-image-1",
            prompt: prompt,
            n: 1,
            size: size,
            quality: quality,
          }),
        }
      );

      if (!openaiResponse.ok) {
        let errorData;
        try {
          errorData = await openaiResponse.text();
        } catch (e) {
          errorData = {
            error: "Failed to parse error response",
            status: openaiResponse.status,
          };
        }
        console.error("OpenAI API Error:", errorData);
        return new Response(
          `Image generation failed: ${JSON.stringify(errorData)}`,
          {
            status: openaiResponse.status,
          }
        );
      }

      const imageData = (await openaiResponse.json()) as any;
      console.log("OpenAI API response received, processing image...");

      // Return the first image directly
      try {
        const firstImage = imageData.data[0];
        console.log("Processing first image...");

        const imageBuffer = await getImageBuffer(firstImage);
        console.log(
          `Image buffer created, size: ${imageBuffer.byteLength} bytes`
        );

        // Generate filename
        const filename = url.pathname;
        // Save to R2 - FIXED: Now properly awaited and handled
        try {
          const publicUrl = await saveImageToR2(
            env,
            imageBuffer,
            filename,
            false
          );
          console.log(`Image successfully saved to R2: ${publicUrl}`);
        } catch (saveError) {
          console.error("Failed to save to R2:", saveError);
          // Continue anyway and return the image
        }

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
        return new Response(
          `Image processing failed: ${
            error instanceof Error ? error.message : "Unknown error"
          }`,
          {
            status: 500,
          }
        );
      }
    } catch (error) {
      console.error("Worker Error:", error);
      return new Response(
        `Internal server error: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
        {
          status: 500,
        }
      );
    }
  }),
};
