/**
 * Feishu (Lark) Channel for NanoClaw
 * Receives and sends messages via Feishu Bot using WebSocket long connection.
 */

import * as lark from '@larksuiteoapi/node-sdk';
import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';
import { GROUPS_DIR } from './config.js';

let client: lark.Client;

interface FeishuDeps {
  storeMessageDirect: (params: {
    id: string;
    chatJid: string;
    sender: string;
    senderName: string;
    content: string;
    timestamp: string;
    isFromMe: boolean;
    mediaPath?: string;
    replyToContent?: string;
  }) => void;
  storeChatMetadata: (chatJid: string, timestamp: string, name?: string) => void;
  getGroupFolder: (chatJid: string) => string | undefined;
}

let deps: FeishuDeps;

export function setupFeishu(feishuDeps: FeishuDeps): void {
  deps = feishuDeps;

  const appId = process.env.FEISHU_APP_ID!;
  const appSecret = process.env.FEISHU_APP_SECRET!;
  const domain = process.env.FEISHU_DOMAIN === 'feishu' ? lark.Domain.Feishu : lark.Domain.Lark;

  client = new lark.Client({ appId, appSecret, domain });

  const eventDispatcher = new lark.EventDispatcher({}).register({
    'im.message.receive_v1': async (data) => {
      try {
        await handleMessage(data);
      } catch (err) {
        logger.error({ err }, 'Error handling Feishu message');
      }
    }
  });

  const wsClient = new lark.WSClient({ appId, appSecret, domain });
  wsClient.start({ eventDispatcher });

  logger.info('Feishu WebSocket client started');
}

async function handleMessage(data: {
  sender: {
    sender_id?: { union_id?: string; user_id?: string; open_id?: string };
    sender_type: string;
    tenant_key?: string;
  };
  message: {
    message_id: string;
    chat_id: string;
    chat_type: string;
    message_type: string;
    content: string;
    create_time: string;
    mentions?: Array<{ key: string; id: { open_id?: string }; name: string }>;
    root_id?: string;
    parent_id?: string;
  };
}): Promise<void> {
  const chatId = `fs:${data.message.chat_id}`;
  const senderId = data.sender.sender_id?.open_id || data.sender.sender_id?.user_id || 'unknown';
  const timestamp = new Date(Number(data.message.create_time)).toISOString();

  // Get sender display name (open_id for now; could resolve via API)
  let senderName = senderId;
  if (data.message.mentions?.length) {
    // Try to find sender in mentions context — not always available
    // We'll use open_id as fallback
  }

  let content = '';
  let mediaPath: string | undefined;

  const groupFolder = deps.getGroupFolder(chatId);

  switch (data.message.message_type) {
    case 'text': {
      const parsed = JSON.parse(data.message.content);
      content = parsed.text || '';
      // Remove @mention placeholders like @_user_1
      if (data.message.mentions) {
        for (const mention of data.message.mentions) {
          content = content.replace(mention.key, `@${mention.name}`);
        }
      }
      break;
    }
    case 'image': {
      if (groupFolder) {
        const parsed = JSON.parse(data.message.content);
        const imageKey = parsed.image_key;
        if (imageKey) {
          try {
            mediaPath = await downloadFeishuResource(
              data.message.message_id, imageKey, 'image', groupFolder,
              `${data.message.message_id}_${Date.now()}.png`
            );
            content = '[图片]';
          } catch (err) {
            logger.error({ chatId, err }, 'Failed to download Feishu image');
            content = '[图片下载失败]';
          }
        }
      } else {
        content = '[图片]';
      }
      break;
    }
    case 'file': {
      if (groupFolder) {
        const parsed = JSON.parse(data.message.content);
        const fileKey = parsed.file_key;
        const fileName = parsed.file_name || 'file';
        if (fileKey) {
          try {
            mediaPath = await downloadFeishuResource(
              data.message.message_id, fileKey, 'file', groupFolder,
              `${data.message.message_id}_${fileName}`
            );
            content = `[文件: ${fileName}]`;
          } catch (err) {
            logger.error({ chatId, err }, 'Failed to download Feishu file');
            content = `[文件下载失败: ${fileName}]`;
          }
        }
      } else {
        content = '[文件]';
      }
      break;
    }
    default: {
      logger.debug({ chatId, messageType: data.message.message_type }, 'Unsupported Feishu message type');
      return;
    }
  }

  if (!content && !mediaPath) return;

  // Handle reply context
  let replyToContent: string | undefined;
  if (data.message.parent_id) {
    replyToContent = '[回复消息]';
  }

  deps.storeChatMetadata(chatId, timestamp);
  deps.storeMessageDirect({
    id: data.message.message_id,
    chatJid: chatId,
    sender: senderId,
    senderName,
    content,
    timestamp,
    isFromMe: false,
    mediaPath,
    replyToContent,
  });

  logger.info({ chatId, senderName, messageType: data.message.message_type }, `Feishu message: ${content.substring(0, 50)}...`);
}

async function downloadFeishuResource(
  messageId: string,
  fileKey: string,
  type: string,
  groupFolder: string,
  fileName: string
): Promise<string> {
  const mediaDir = path.join(GROUPS_DIR, groupFolder, 'media');
  fs.mkdirSync(mediaDir, { recursive: true });
  const filePath = path.join(mediaDir, fileName);

  const resp = await client.im.messageResource.get({
    params: { type },
    path: { message_id: messageId, file_key: fileKey },
  });

  await resp!.writeFile(filePath);
  return filePath;
}

export async function feishuSendMessage(chatId: string, text: string): Promise<void> {
  await client.im.message.create({
    params: { receive_id_type: 'chat_id' },
    data: {
      receive_id: chatId,
      content: JSON.stringify({ text }),
      msg_type: 'text',
    },
  });
}

export async function feishuSendFile(
  chatId: string,
  filePath: string,
  isImage: boolean,
  caption?: string
): Promise<void> {
  if (isImage) {
    // Upload image first, then send as image message
    const imageResp = await client.im.image.create({
      data: {
        image_type: 'message',
        image: fs.createReadStream(filePath),
      },
    });
    const imageKey = imageResp?.image_key;
    if (!imageKey) throw new Error('Failed to upload image to Feishu');

    await client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        content: JSON.stringify({ image_key: imageKey }),
        msg_type: 'image',
      },
    });

    // Send caption as separate text message if present
    if (caption) {
      await feishuSendMessage(chatId, caption);
    }
  } else {
    // Upload file first, then send as file message
    const ext = path.extname(filePath).toLowerCase().slice(1);
    const fileType = (['pdf', 'doc', 'xls', 'ppt', 'mp4', 'opus'].includes(ext) ? ext : 'stream') as
      'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream';

    const fileResp = await client.im.file.create({
      data: {
        file_type: fileType,
        file_name: path.basename(filePath),
        file: fs.createReadStream(filePath),
      },
    });
    const fileKey = fileResp?.file_key;
    if (!fileKey) throw new Error('Failed to upload file to Feishu');

    await client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        content: JSON.stringify({ file_key: fileKey }),
        msg_type: 'file',
      },
    });

    if (caption) {
      await feishuSendMessage(chatId, caption);
    }
  }
}
