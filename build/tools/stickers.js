import { z } from "zod";
import { makeYougileRequest } from "../common/request-helper.js";
export const registerStickerTools = (server) => {
    server.tool("get_string_stickers", "Get all string stickers (custom stickers with states) for a board", {
        boardId: z.string().optional().describe("Filter by board ID"),
        limit: z.number().optional().describe("Limit number of stickers returned"),
        offset: z.number().optional().describe("Offset for pagination"),
        name: z.string().optional().describe("Filter by sticker name"),
    }, async ({ boardId, limit, offset, name }) => {
        const queryParams = new URLSearchParams();
        if (boardId)
            queryParams.append('boardId', boardId);
        if (limit)
            queryParams.append('limit', limit.toString());
        if (offset)
            queryParams.append('offset', offset.toString());
        if (name)
            queryParams.append('name', name);
        const queryString = queryParams.toString();
        const path = `string-stickers${queryString ? '?' + queryString : ''}`;
        const stickers = await makeYougileRequest("GET", path);
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(stickers, null, 2),
                },
            ],
        };
    });
    server.tool("get_string_sticker", "Get a specific string sticker by ID with its states", {
        id: z.string().describe("The ID of the sticker to retrieve"),
    }, async ({ id }) => {
        const sticker = await makeYougileRequest("GET", `string-stickers/${id}`);
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(sticker, null, 2),
                },
            ],
        };
    });
};
