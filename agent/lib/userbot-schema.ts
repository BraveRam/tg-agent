// Generated worker contract; credentials excluded.
export default {
  openapi: "3.1.0",
  info: {
    title: "tg-agent userbot reader",
    version: "0.1.0",
  },
  paths: {
    "/health": {
      get: {
        summary: "Health",
        operationId: "userbotHealth",
        responses: {
          "200": {
            description: "Successful Response",
            content: {
              "application/json": {
                schema: {},
              },
            },
          },
        },
        security: [
          {
            HTTPBearer: [],
          },
        ],
      },
    },
    "/resolve": {
      post: {
        summary: "Resolve",
        operationId: "resolveChannel",
        requestBody: {
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/ChannelRequest",
              },
            },
          },
          required: true,
        },
        responses: {
          "200": {
            description: "Successful Response",
            content: {
              "application/json": {
                schema: {},
              },
            },
          },
          "422": {
            description: "Validation Error",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/HTTPValidationError",
                },
              },
            },
          },
        },
        security: [
          {
            HTTPBearer: [],
          },
        ],
      },
    },
    "/messages": {
      post: {
        summary: "Messages",
        operationId: "readMessages",
        requestBody: {
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/MessagesRequest",
              },
            },
          },
          required: true,
        },
        responses: {
          "200": {
            description: "Successful Response",
            content: {
              "application/json": {
                schema: {},
              },
            },
          },
          "422": {
            description: "Validation Error",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/HTTPValidationError",
                },
              },
            },
          },
        },
        security: [
          {
            HTTPBearer: [],
          },
        ],
      },
    },
    "/media": {
      post: {
        summary: "Media",
        operationId: "retrievePhoto",
        requestBody: {
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/MediaRequest",
              },
            },
          },
          required: true,
        },
        responses: {
          "200": {
            description: "Successful Response",
            content: {
              "application/json": {
                schema: {},
              },
            },
          },
          "422": {
            description: "Validation Error",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/HTTPValidationError",
                },
              },
            },
          },
        },
        security: [
          {
            HTTPBearer: [],
          },
        ],
      },
    },
    "/join": {
      post: {
        summary: "Join Source",
        operationId: "joinSourceChannel",
        requestBody: {
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/ChannelRequest",
              },
            },
          },
          required: true,
        },
        responses: {
          "200": {
            description: "Successful Response",
            content: {
              "application/json": {
                schema: {},
              },
            },
          },
          "422": {
            description: "Validation Error",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/HTTPValidationError",
                },
              },
            },
          },
        },
        security: [
          {
            HTTPBearer: [],
          },
        ],
      },
    },
  },
  components: {
    schemas: {
      ChannelRequest: {
        properties: {
          channel: {
            type: "string",
            title: "Channel",
          },
        },
        type: "object",
        required: ["channel"],
        title: "ChannelRequest",
      },
      HTTPValidationError: {
        properties: {
          detail: {
            items: {
              $ref: "#/components/schemas/ValidationError",
            },
            type: "array",
            title: "Detail",
          },
        },
        type: "object",
        title: "HTTPValidationError",
      },
      MediaRequest: {
        properties: {
          channel: {
            type: "string",
            title: "Channel",
          },
          messageId: {
            type: "integer",
            exclusiveMinimum: 0.0,
            title: "Messageid",
          },
        },
        type: "object",
        required: ["channel", "messageId"],
        title: "MediaRequest",
      },
      MessagesRequest: {
        properties: {
          channel: {
            type: "string",
            title: "Channel",
          },
          ids: {
            anyOf: [
              {
                items: {
                  type: "integer",
                },
                type: "array",
                maxItems: 100,
              },
              {
                type: "null",
              },
            ],
            title: "Ids",
          },
          limit: {
            type: "integer",
            maximum: 100.0,
            minimum: 1.0,
            title: "Limit",
            default: 30,
          },
          beforeId: {
            type: "integer",
            minimum: 0.0,
            title: "Beforeid",
            default: 0,
          },
          afterId: {
            type: "integer",
            minimum: 0.0,
            title: "Afterid",
            default: 0,
          },
          beforeDate: {
            anyOf: [
              {
                type: "number",
              },
              {
                type: "null",
              },
            ],
            title: "Beforedate",
          },
          afterDate: {
            anyOf: [
              {
                type: "number",
              },
              {
                type: "null",
              },
            ],
            title: "Afterdate",
          },
        },
        type: "object",
        required: ["channel"],
        title: "MessagesRequest",
      },
      ValidationError: {
        properties: {
          loc: {
            items: {
              anyOf: [
                {
                  type: "string",
                },
                {
                  type: "integer",
                },
              ],
            },
            type: "array",
            title: "Location",
          },
          msg: {
            type: "string",
            title: "Message",
          },
          type: {
            type: "string",
            title: "Error Type",
          },
          input: {
            title: "Input",
          },
          ctx: {
            type: "object",
            title: "Context",
          },
        },
        type: "object",
        required: ["loc", "msg", "type"],
        title: "ValidationError",
      },
    },
    securitySchemes: {
      HTTPBearer: {
        type: "http",
        scheme: "bearer",
      },
    },
  },
};
