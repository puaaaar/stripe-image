import {
  withStripeflare,
  StripeUser,
  DORM,
  Env as StripeflareEnv,
} from "stripeflare";

export { DORM };

// =============================================================================
// TYPES
// =============================================================================

type Env = StripeflareEnv & {
  stripeimages: R2Bucket;
  R2_PUBLIC_URL: string | undefined;
  R2_DEV_URL: string | undefined;
  R2_BUCKET_ID: string;
  ENVIRONMENT: string;
  OPENAI_API_KEY: string;
};

interface ImageCostParams {
  prompt: string;
  size: string;
  quality: string;
  inputImageTokens?: number;
  cachedInputTokens?: number;
}

interface ImageCostBreakdown {
  textInputTokens: number;
  textInputCost: number;
  imageInputTokens: number;
  imageInputCost: number;
  imageOutputCost: number;
  totalCostInDollars: number;
  breakdown: {
    textInput: string;
    imageInput: string;
    imageOutput: string;
    total: string;
  };
}

interface ImageParams {
  prompt: string;
  size: string;
  quality: string;
}

interface OpenAIImageResponse {
  data: Array<{
    url?: string;
    b64_json?: string;
  }>;
}

// =============================================================================
// CONSTANTS
// =============================================================================

const PRICING = {
  TEXT_INPUT_PER_1M: 5.0,
  TEXT_INPUT_CACHED_PER_1M: 1.25,
  IMAGE_INPUT_PER_1M: 10.0,
  IMAGE_INPUT_CACHED_PER_1M: 2.5,
  IMAGE_OUTPUT_PER_1M: 40.0,
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
      "1024x1024": 0.167,
      "1024x1536": 0.25,
      "1536x1024": 0.25,
    },
  },
  FEE_PERCENTAGE_PER_IMAGE: 1.2,
} as const;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Cookie",
  "Access-Control-Max-Age": "86400",
} as const;

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

function calculateImageTokens(width: number, height: number): number {
  const shortestSide = Math.min(width, height);
  const scaleFactor = 512 / shortestSide;

  const scaledWidth = Math.ceil(width * scaleFactor);
  const scaledHeight = Math.ceil(height * scaleFactor);

  const tilesX = Math.ceil(scaledWidth / 512);
  const tilesY = Math.ceil(scaledHeight / 512);
  const totalTiles = tilesX * tilesY;

  return totalTiles * 129 + 65;
}

function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function parseImageSize(size: string): { width: number; height: number } {
  const [widthStr, heightStr] = size.split("x");
  return {
    width: parseInt(widthStr, 10),
    height: parseInt(heightStr, 10),
  };
}

function parseImagePath(pathname: string): ImageParams | null {
  const parts = pathname
    .replace(/^\/+/, "")
    .split("/")
    .filter((part) => part.length > 0);

  if (parts.length < 2 || parts[0] !== "image") {
    return null;
  }

  const prompt = parts[1] ? decodeURIComponent(parts[1]) : "";
  const size = parts[2] || "1024x1024";
  const quality = parts[3] || "low";

  return prompt ? { prompt, size, quality } : null;
}

// =============================================================================
// COST CALCULATION
// =============================================================================

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

  const normalizedQuality =
    quality.toLowerCase() as keyof typeof PRICING.OUTPUT_COSTS;

  // Text input cost
  const textInputTokens = estimateTextTokens(prompt);
  const textInputCost =
    cachedInputTokens > 0
      ? (cachedInputTokens / 1_000_000) * PRICING.TEXT_INPUT_CACHED_PER_1M
      : (textInputTokens / 1_000_000) * PRICING.TEXT_INPUT_PER_1M;

  // Image input cost
  const imageInputCost =
    inputImageTokens > 0
      ? (inputImageTokens / 1_000_000) * PRICING.IMAGE_INPUT_PER_1M
      : 0;

  // Image output cost
  const imageOutputCost = PRICING.OUTPUT_COSTS[normalizedQuality]?.[size] || 0;

  // Total with fee
  const totalCostInDollars =
    (textInputCost + imageInputCost + imageOutputCost) *
    PRICING.FEE_PERCENTAGE_PER_IMAGE;

  return {
    textInputTokens,
    textInputCost,
    imageInputTokens: inputImageTokens,
    imageInputCost,
    imageOutputCost,
    totalCostInDollars,
    breakdown: {
      textInput: `$${textInputCost} (${textInputTokens.toLocaleString()} tokens)`,
      imageInput:
        inputImageTokens > 0
          ? `$${imageInputCost} (${inputImageTokens.toLocaleString()} tokens)`
          : "$0.00 (0 tokens)",
      imageOutput: `$${imageOutputCost} (0 tokens)`,
      total: `$${totalCostInDollars}`,
    },
  };
}

// =============================================================================
// R2 STORAGE
// =============================================================================

async function saveImageToR2(
  env: Env,
  imageData: string | ArrayBuffer,
  filename: string,
  isBase64: boolean = false
): Promise<string> {
  let imageBuffer: ArrayBuffer;

  if (isBase64 && typeof imageData === "string") {
    const base64Data = imageData.replace(/^data:image\/[a-z]+;base64,/, "");
    const binaryString = atob(base64Data);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    imageBuffer = bytes.buffer;
  } else if (typeof imageData === "string") {
    const response = await fetch(imageData);
    if (!response.ok) {
      throw new Error(`Failed to fetch image: ${response.status}`);
    }
    imageBuffer = await response.arrayBuffer();
  } else {
    imageBuffer = imageData;
  }

  await env.stripeimages.put(filename, imageBuffer, {
    httpMetadata: {
      contentType: "image/png",
      cacheControl: "public, max-age=31536000",
    },
  });

  const isDev = env.ENVIRONMENT === "development";
  const baseUrl = isDev
    ? env.R2_DEV_URL || `https://pub-${env.R2_BUCKET_ID}.r2.dev`
    : env.R2_PUBLIC_URL || "https://imagebucket.brubslabs.com";

  return `${baseUrl}/${filename}`;
}

async function getImageFromR2(
  env: Env,
  filename: string
): Promise<Response | null> {
  const stored = await env.stripeimages.get(filename);

  if (!stored) {
    return null;
  }

  return new Response(stored.body, {
    headers: {
      "Content-Type": stored.httpMetadata?.contentType || "image/png",
      "Content-Disposition": `inline; filename="${filename}"`,
      "Cache-Control": "public, max-age=3600",
      ...CORS_HEADERS,
    },
  });
}

// =============================================================================
// OPENAI API
// =============================================================================

async function generateImage(
  env: Env,
  params: ImageParams
): Promise<ArrayBuffer> {
  const response = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
      "User-Agent": "StripeImages/1.0",
      Accept: "application/json",
    },
    body: JSON.stringify({
      model: "gpt-image-1",
      prompt: params.prompt,
      n: 1,
      size: params.size,
      quality: params.quality,
    }),
  });

  if (!response.ok) {
    const errorData = await response.text();
    throw new Error(`OpenAI API Error: ${errorData}`);
  }

  const imageData = (await response.json()) as OpenAIImageResponse;
  const firstImage = imageData.data[0];

  if (firstImage.b64_json) {
    const base64Data = firstImage.b64_json.replace(
      /^data:image\/[a-z]+;base64,/,
      ""
    );
    const binaryString = atob(base64Data);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
  } else if (firstImage.url) {
    const imageResponse = await fetch(firstImage.url);
    if (!imageResponse.ok) {
      throw new Error(`Failed to fetch image: ${imageResponse.status}`);
    }
    return await imageResponse.arrayBuffer();
  }

  throw new Error("No image data found in response");
}

// =============================================================================
// RESPONSE HANDLERS
// =============================================================================

function createLandingPageResponse(user: StripeUser): Response {
  const landingPage = `Welcome to image.brubslabs.com!

Your Balance: $${(user.balance / 100).toFixed(2)}
Your Access Token: ${user.access_token}

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

curl -X GET \\
  -H "Cookie: access_token=your-access-token" \\
  "https://image.brubslabs.com/image/cat/1024x1024/high"

Note: Add URL-encode spaces in the prompt (e.g., '%20' for spaces)

# Pricing:

Cost includes: (input text tokens + input image tokens + output image tokens) * fee percentage

Fee percentage: ${Math.ceil(
    (PRICING.FEE_PERCENTAGE_PER_IMAGE - 1) * 100
  )}% of total cost

## Output tokens:

| Quality | Square (1024x1024) | Portrait (1024x1536) | Landscape (1536x1024) |
|---------|--------------------|----------------------|-----------------------|
| Low     | $0.011             | $0.016               | $0.016                |
| Medium  | $0.042             | $0.063               | $0.063                |
| High    | $0.167             | $0.25                | $0.25                 |

## Input tokens (per 1M tokens):

| Type                         | Input  | Cached input | Output               |
|------------------------------|--------|--------------|----------------------|
| Text tokens                  | $5.00  | $1.25        | -                    |
| Image tokens (comming soon)  | $10.00 | $2.50        | $40.00               |`;

  return new Response(landingPage, {
    headers: {
      "Content-Type": "text/plain",
      ...CORS_HEADERS,
    },
    status: 400,
  });
}

function createCostResponse(url: URL, params: ImageParams, ctx: any): Response {
  const costBreakdown = calculateImageGenerationCost(params);

  const costText = `Image Generation Cost Estimate

Prompt: ${params.prompt}
Size: ${params.size}
Quality: ${params.quality}

# Cost Breakdown:

Text Input: ${costBreakdown.breakdown.textInput}
Image Input: ${costBreakdown.breakdown.imageInput}
Image Output: ${costBreakdown.breakdown.imageOutput}
Fee Percentage: ${Math.ceil((PRICING.FEE_PERCENTAGE_PER_IMAGE - 1) * 100)}%

Total Cost: ${costBreakdown.breakdown.total}

# Generation URL:

${url.origin}/image/${encodeURIComponent(params.prompt)}/${params.size}/${
    params.quality
  }

${
  ctx.registered
    ? `# Your Account:

Current Balance: $${(ctx.user.balance / 100).toFixed(2)}
Can Afford: ${
        ctx.user.balance >= costBreakdown.totalCostInDollars ? "Yes" : "No"
      }
Balance After Generation: $${(
        (ctx.user.balance - costBreakdown.totalCostInDollars) /
        100
      ).toFixed(2)}`
    : `# Payment Required:

You are not registered. Visit the payment link below to add balance:
${ctx.paymentLink}`
}

To generate this image, visit the generation URL above.
Cost: ${costBreakdown.breakdown.total}`;

  return new Response(costText, {
    headers: {
      "Content-Type": "text/plain",
      "Cache-Control": "no-cache",
      ...CORS_HEADERS,
    },
  });
}

function createErrorResponse(message: string, status: number = 400): Response {
  const body =
    status === 405
      ? message
      : JSON.stringify(
          {
            error: message,
            usage:
              "Use: /cost/prompt[/size][/quality] or /image/prompt[/size][/quality]",
            examples: [
              "/cost/cat",
              "/cost/cat/1024x1024",
              "/cost/cat/1024x1024/high",
              "/image/cat",
              "/image/cat/1024x1024/high",
            ],
          },
          null,
          2
        );

  const headers =
    status === 405
      ? { Allow: "GET, OPTIONS", ...CORS_HEADERS }
      : {
          "Content-Type": "application/json",
          "Cache-Control": "no-cache",
          ...CORS_HEADERS,
        };

  return new Response(body, { status, headers });
}

// =============================================================================
// REQUEST HANDLERS
// =============================================================================

async function handleCostRequest(
  request: Request,
  env: Env,
  ctx: any
): Promise<Response> {
  const url = new URL(request.url);
  const imagePath = url.pathname.replace("/cost/", "/image/");
  const pathParams = parseImagePath(imagePath);

  if (!pathParams) {
    return createErrorResponse("Invalid cost path format");
  }

  return createCostResponse(url, pathParams, ctx);
}

async function handleImageRequest(
  request: Request,
  env: Env,
  ctx: any
): Promise<Response> {
  const url = new URL(request.url);
  const filename = url.pathname;

  // Check for cached image first
  const cachedImage = await getImageFromR2(env, filename);
  if (cachedImage) {
    return cachedImage;
  }

  // Check user authentication and balance
  if (!ctx.registered || ctx.user.balance <= 0) {
    return new Response(null, {
      status: 302,
      headers: { Location: ctx.paymentLink },
    });
  }

  // Parse image generation parameters
  const pathParams = parseImagePath(url.pathname);

  if (!pathParams) {
    return createLandingPageResponse(ctx.user);
  }

  // Calculate and charge for the image
  const costBreakdown = calculateImageGenerationCost(pathParams);
  const { charged, message } = await ctx.charge(
    costBreakdown.totalCostInDollars,
    false
  );

  if (!charged) {
    return new Response(`Payment failed: ${message}`, { status: 402 });
  }

  // Generate the image
  const imageBuffer = await generateImage(env, pathParams);

  // Save to R2 (don't wait for completion)
  saveImageToR2(env, imageBuffer, filename, false).catch((error) => {
    console.error("Failed to save to R2:", error);
  });

  // Return the image directly
  return new Response(imageBuffer, {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "Content-Disposition": `inline; filename="${filename}"`,
      "Cache-Control": "public, max-age=3600",
      ...CORS_HEADERS,
    },
  });
}

// =============================================================================
// MAIN HANDLER
// =============================================================================

export default {
  fetch: withStripeflare<StripeUser>(async (request, env: Env, ctx) => {
    try {
      // Handle CORS preflight
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: CORS_HEADERS,
        });
      }

      // Only handle GET requests
      if (request.method !== "GET") {
        return createErrorResponse("Method Not Allowed", 405);
      }

      const url = new URL(request.url);

      // Route requests
      if (url.pathname.startsWith("/cost")) {
        return await handleCostRequest(request, env, ctx);
      } else {
        return await handleImageRequest(request, env, ctx);
      }
    } catch (error) {
      console.error("Worker Error:", error);
      return createErrorResponse(
        `Internal server error: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
        500
      );
    }
  }),
};
