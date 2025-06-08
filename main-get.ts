import { withStripeflare, StripeUser, DORM } from "stripeflare";
export { DORM };

export default {
  fetch: withStripeflare<StripeUser>(async (request, env, ctx) => {
    const t = Date.now();

    // Check if user is registered and has balance
    if (!ctx.registered || ctx.user.balance <= 0) {
      return new Response("User should pay at " + ctx.paymentLink, {
        status: 402,
        headers: { Location: ctx.paymentLink },
      });
    }

    // Only handle GET requests for image generation
    if (request.method !== "GET") {
      return new Response("Method not allowed. Use GET to generate images.", {
        status: 405,
        headers: { Allow: "GET" },
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
        return new Response(
          "Missing or invalid required query parameter: prompt",
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      // Validate other parameters
      if (
        typeof size !== "string" ||
        !["256x256", "512x512", "1024x1024", "1024x1792", "1792x1024"].includes(
          size
        )
      ) {
        return new Response(
          "Invalid size. Must be one of: 256x256, 512x512, 1024x1024, 1024x1792, 1792x1024",
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      if (
        typeof quality !== "string" ||
        !["low", "medium", "high", "auto"].includes(quality)
      ) {
        return new Response('Invalid quality. Must be "low" or "high"', {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (isNaN(n) || n < 1 || n > 4) {
        return new Response("Invalid n. Must be a number between 1 and 4", {
          status: 400,
          headers: { "Content-Type": "application/json" },
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
        return new Response(
          JSON.stringify({
            error: "Could not charge user",
            message,
            processingTime: `${speed}ms`,
          }),
          {
            status: 402,
            headers: { "Content-Type": "application/json" },
          }
        );
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

        return new Response(
          JSON.stringify({
            error: "Image generation failed",
            details: errorData,
            charged: true,
            user: ctx.user.name,
            processingTime: `${speed}ms`,
          }),
          {
            status: openaiResponse.status,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      const imageData = (await openaiResponse.json()) as any;

      // Return successful response with image data
      return new Response(
        JSON.stringify({
          success: true,
          images: imageData.data,
          charged: true,
          costInCents,
          user: ctx.user.name,
          processingTime: `${speed}ms`,
          prompt: prompt,
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*", // Add CORS if needed
            "Access-Control-Allow-Methods": "GET",
            "Access-Control-Allow-Headers": "Content-Type",
          },
        }
      );
    } catch (error) {
      const speed = Date.now() - t;
      console.error("Worker Error:", error);

      return new Response(
        JSON.stringify({
          error: "Internal server error",
          message: error instanceof Error ? error.message : "Unknown error",
          processingTime: `${speed}ms`,
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }
      );
    }
  }),
};
