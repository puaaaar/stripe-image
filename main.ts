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

// Cost calculation types
interface ImageCostParams {
  prompt: string;
  size: string;
  quality: string;
  inputImageTokens?: number; // For image-to-image or input images
  cachedInputTokens?: number; // For cached input tokens
}

interface ImageCostBreakdown {
  textInputTokens: number;
  textInputCost: number;
  imageInputTokens: number;
  imageInputCost: number;
  imageOutputCost: number;
  totalCostInCents: number;
  breakdown: {
    textInput: string;
    imageInput: string;
    imageOutput: string;
    total: string;
  };
}

// Pricing constants (in dollars)
const PRICING = {
  TEXT_INPUT_PER_1M: 5.0,
  TEXT_INPUT_CACHED_PER_1M: 1.25,
  IMAGE_INPUT_PER_1M: 10.0,
  IMAGE_INPUT_CACHED_PER_1M: 2.5,
  IMAGE_OUTPUT_PER_1M: 40.0,

  // Output image costs (in dollars)
  OUTPUT_COSTS: {
    low: {
      "1024x1024": 0.011,
      "1024x1536": 0.016,
      "1536x1024": 0.016,
    },
    medium: {
      "1024x1024": 0.042,
      "1024x1536": 0.063,
      "1536x1024": 0.063,
    },
    high: {
      "1024x1024": 0.167,
      "1024x1536": 0.25,
      "1536x1024": 0.25,
    },
    auto: {
      // Same as high
      "1024x1024": 0.167,
      "1024x1536": 0.25,
      "1536x1024": 0.25,
    },
  },
  FEE_PERCENTAGE_PER_IMAGE: 0.1, // 10% fee on total cost
};

/**
 * Calculate image tokens based on dimensions
 * Formula: Scale image so shortest side = 512px, count 512px tiles needed
 * Cost: (tiles x 129) + 65 tokens
 */
function calculateImageTokens(width: number, height: number): number {
  // Scale so shortest side = 512px
  const shortestSide = Math.min(width, height);
  const scaleFactor = 512 / shortestSide;

  const scaledWidth = Math.ceil(width * scaleFactor);
  const scaledHeight = Math.ceil(height * scaleFactor);

  // Count 512px tiles needed
  const tilesX = Math.ceil(scaledWidth / 512);
  const tilesY = Math.ceil(scaledHeight / 512);
  const totalTiles = tilesX * tilesY;

  // Calculate tokens: (tiles x 129) + 65
  return totalTiles * 129 + 65;
}

/**
 * Estimate text tokens (rough approximation: 1 token ≈ 4 characters)
 */
function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Parse image size string to width and height
 */
function parseImageSize(size: string): { width: number; height: number } {
  const [widthStr, heightStr] = size.split("x");
  return {
    width: parseInt(widthStr, 10),
    height: parseInt(heightStr, 10),
  };
}

/**
 * Calculate comprehensive cost for image generation
 */
export function calculateImageGenerationCost(
  params: ImageCostParams
): ImageCostBreakdown {
  const {
    prompt,
    size,
    quality,
    inputImageTokens = 0,
    cachedInputTokens = 0,
  } = params;

  // Normalize quality
  const normalizedQuality =
    quality.toLowerCase() as keyof typeof PRICING.OUTPUT_COSTS;

  // Calculate text input tokens and cost
  const textInputTokens = estimateTextTokens(prompt);
  const textInputCost =
    cachedInputTokens > 0
      ? (cachedInputTokens / 1_000_000) * PRICING.TEXT_INPUT_CACHED_PER_1M
      : (textInputTokens / 1_000_000) * PRICING.TEXT_INPUT_PER_1M;

  // Calculate image input tokens and cost
  const imageInputCost =
    inputImageTokens > 0
      ? (inputImageTokens / 1_000_000) * PRICING.IMAGE_INPUT_PER_1M
      : 0;

  // Calculate image output cost
  let imageOutputCost = 0;
  let imageOutputTokens = 0;

  if (
    PRICING.OUTPUT_COSTS[normalizedQuality] &&
    PRICING.OUTPUT_COSTS[normalizedQuality][size]
  ) {
    imageOutputCost = PRICING.OUTPUT_COSTS[normalizedQuality][size];
  }

  // Fee cost
  const feePercentage = PRICING.FEE_PERCENTAGE_PER_IMAGE;

  // Total cost in dollars
  const totalCostInDollars =
    (textInputCost + imageInputCost + imageOutputCost) * feePercentage;
  const totalCostInCents = Math.ceil(totalCostInDollars * 100);

  return {
    textInputTokens,
    textInputCost,
    imageInputTokens: inputImageTokens,
    imageInputCost,
    imageOutputCost,
    totalCostInCents,
    breakdown: {
      textInput: `$${textInputCost.toFixed(
        5
      )} (${textInputTokens.toLocaleString()} tokens)`,
      imageInput:
        inputImageTokens > 0
          ? `$${imageInputCost.toFixed(
              5
            )} (${inputImageTokens.toLocaleString()} tokens)`
          : "$0.00000 (0 tokens)",
      imageOutput: `$${imageOutputCost.toFixed(
        5
      )} (${imageOutputTokens.toLocaleString()} tokens)`,
      total: `$${totalCostInDollars.toFixed(5)} (${totalCostInCents}¢)`,
    },
  };
}

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
          "Access-Control-Allow-Methods": "GET",
          "Access-Control-Allow-Headers": "Authorization, Content-Type, Cookie",
          "Cache-Control": "public, max-age=3600", // Cache for 1 hour
        },
      });
    }

    // Handle cost calculation endpoint
    if (url.pathname.startsWith("/cost")) {
      // Convert /cost/prompt/size/quality to /image/prompt/size/quality for parsing
      const imagePath = url.pathname.replace("/cost/", "/image/");
      const pathParams = parseImagePath(imagePath);

      if (!pathParams) {
        return new Response(
          JSON.stringify(
            {
              error: "Invalid cost path format",
              usage: "Use: /cost/prompt[/size][/quality]",
              examples: [
                "/cost/cat",
                "/cost/cat/1024x1024",
                "/cost/cat/1024x1024/high",
              ],
            },
            null,
            2
          ),
          {
            status: 400,
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
              "Access-Control-Allow-Methods": "GET",
              "Access-Control-Allow-Headers":
                "Authorization, Content-Type, Cookie",
              "Cache-Control": "no-cache",
              "Access-Control-Max-Age": "86400", // Cache preflight for 1 day
            },
          }
        );
      }

      const { prompt, size, quality } = pathParams;

      // Calculate cost breakdown
      const costBreakdown = calculateImageGenerationCost({
        prompt,
        size,
        quality,
      });

      // Build the response
      const response = {
        prompt,
        size,
        quality,
        cost: {
          breakdown: costBreakdown.breakdown,
          totalCents: costBreakdown.totalCostInCents,
          details: {
            textInputTokens: costBreakdown.textInputTokens,
            textInputCost: costBreakdown.textInputCost,
            imageInputTokens: costBreakdown.imageInputTokens,
            imageInputCost: costBreakdown.imageInputCost,
            imageOutputCost: costBreakdown.imageOutputCost,
          },
        },
        generation: {
          url: `${url.origin}/image/${encodeURIComponent(
            prompt
          )}/${size}/${quality}`,
          message: `To generate this image, visit the URL above. Cost: ${costBreakdown.breakdown.total}`,
        },
        user: ctx.registered
          ? {
              balance: ctx.user.balance,
              canAfford: ctx.user.balance >= costBreakdown.totalCostInCents,
              balanceAfter: ctx.user.balance - costBreakdown.totalCostInCents,
            }
          : {
              message:
                "User not registered. Visit payment link to add balance.",
              paymentLink: ctx.paymentLink,
            },
      };

      return new Response(JSON.stringify(response, null, 2), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET",
          "Access-Control-Allow-Headers": "Authorization, Content-Type, Cookie",
          "Cache-Control": "no-cache",
          "Access-Control-Max-Age": "86400", // Cache preflight for 1 day
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

      const landingPage = `Welcome to image.brubslabs.com!

Your Balance: $${(ctx.user.balance / 100).toFixed(2)}
Your Access Token: ${ctx.user.access_token}

# Use the following format to generate images:

https://image.brubslabs.com/image/prompt[/size][/quality]

- prompt: any text prompt (required)
- size: 1024x1024 (default), 1024x1536, 1536x1024
- quality: low (default), medium, high, auto

Examples:

- /image/cat
- /image/cat/1024x1024  
- /image/cat/1024x1024/high

# Access Token Usage:

curl -X GET \\\n
  -H "Cookie: access_token=your-access-token" \\\n
  "https://image.brubslabs.com/image/cat/1024x1024/high"

Note: Add URL-encode spaces in the prompt (e.g., '%20' for spaces)

# Pricing:

Cost includes: (input text tokens + input image tokens + output image tokens) * fee percentage

Fee percentage: 10% of total cost

## Output tokens:

| Quality | Square (1024x1024) | Portrait (1024x1536) | Landscape (1536x1024) |
|---------|--------------------|----------------------|-----------------------|
| Low     | $0.011             | $0.016               | $0.016                |
| Medium  | $0.042             | $0.063               | $0.063                |
| High    | $0.167             | $0.25                | $0.25                 |

## Input tokens (per 1M tokens):

| Type             | Input     | Cached input         | Output                |
|------------------|-----------|----------------------|-----------------------|
| Text tokens      | $5.00     | $1.25                | -                     |
| Image tokens     | $10.00    | $2.50                | $40.00                |

### Image tokens calculation (comming soon):

Scale image so shortest side = 512px
Count 512px tiles needed
Calculate cost: (tiles x 129) + 65 tokens

Examples:

1024x1024 → 512x512 → 1 tile → 194 tokens
2048x4096 → 512x1024 → 2 tiles → 323 tokens`;

      const corsHeaders = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET",
        "Access-Control-Allow-Headers": "Authorization, Content-Type, Cookie",
        "Access-Control-Max-Age": "86400",
      } as const;

      if (!pathParams) {
        return new Response(landingPage, {
          headers: {
            "Content-Type": "text/plain",
            ...corsHeaders,
          },
          status: 400,
        });
      }

      const { prompt, size, quality } = pathParams;

      console.log("Parsed parameters:", { prompt, size, quality });

      // Calculate cost based on image parameters
      const costBreakdown = calculateImageGenerationCost({
        prompt,
        size,
        quality,
      });
      const totalCostInCents = costBreakdown.totalCostInCents;

      console.log("Cost breakdown:", costBreakdown);

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
            headers: {
              "Content-Type": "application/json",
              ...corsHeaders,
            },
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
            "Access-Control-Allow-Headers":
              "Authorization, Content-Type, Cookie",
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
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
              "Access-Control-Allow-Methods": "GET",
              "Access-Control-Allow-Headers":
                "Authorization, Content-Type, Cookie",
            },
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
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET",
            "Access-Control-Allow-Headers":
              "Authorization, Content-Type, Cookie",
          },
          status: 500,
        }
      );
    }
  }),
};
