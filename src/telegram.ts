/**
 * Telegram Channel for NanoClaw
 * Receives and sends messages via Telegraf bot.
 */

import { Telegraf, Input } from 'telegraf';
import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';
import { GROUPS_DIR } from './config.js';

let telegrafBot: Telegraf;

export interface TelegramDeps {
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

let deps: TelegramDeps;

async function downloadTelegramFile(fileId: string, groupFolder: string, fileName: string): Promise<string> {
  const mediaDir = path.join(GROUPS_DIR, groupFolder, 'media');
  fs.mkdirSync(mediaDir, { recursive: true });

  const fileLink = await telegrafBot.telegram.getFileLink(fileId);
  const response = await fetch(fileLink.href);
  const buffer = Buffer.from(await response.arrayBuffer());

  const filePath = path.join(mediaDir, fileName);
  fs.writeFileSync(filePath, buffer);

  return filePath;
}

export function setupTelegram(telegramDeps: TelegramDeps): void {
  deps = telegramDeps;

  telegrafBot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);

  // Handle incoming messages (including text, photos, documents)
  telegrafBot.on('message', async (ctx) => {
    const chatId = 'tg:' + String(ctx.chat.id);
    const isGroup = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
    const senderId = String(ctx.from?.id || ctx.chat.id);
    const senderName = ctx.from?.first_name || ctx.from?.username || 'User';
    const timestamp = new Date(ctx.message.date * 1000).toISOString();

    // Check if this chat is registered
    const groupFolder = deps.getGroupFolder(chatId);
    if (!groupFolder) {
      logger.debug({ chatId }, 'Message from unregistered Telegram chat');
      return;
    }

    let content = '';
    let mediaPath: string | undefined;
    let replyToContent: string | undefined;

    // Check if this is a reply to another message - extract original content directly from Telegram
    if ('reply_to_message' in ctx.message && ctx.message.reply_to_message) {
      const replyMsg = ctx.message.reply_to_message;
      const replySender = replyMsg.from?.first_name || replyMsg.from?.username || 'Unknown';
      let replyText = '';

      if ('text' in replyMsg) {
        replyText = replyMsg.text;
      } else if ('caption' in replyMsg && replyMsg.caption) {
        replyText = replyMsg.caption;
      } else if ('photo' in replyMsg) {
        replyText = '[图片]';
      } else if ('document' in replyMsg) {
        replyText = '[文件]';
      } else {
        replyText = '[消息]';
      }

      // Limit to 100 chars for brevity
      replyToContent = `${replySender}: ${replyText.substring(0, 100)}`;
    }

    // Handle different message types
    if ('text' in ctx.message) {
      content = ctx.message.text;
    } else if ('photo' in ctx.message) {
      // Get the largest photo (last in array)
      const photo = ctx.message.photo[ctx.message.photo.length - 1];
      const caption = ('caption' in ctx.message ? ctx.message.caption : '') || '';
      const fileName = `${ctx.message.message_id}_${Date.now()}.jpg`;

      try {
        mediaPath = await downloadTelegramFile(photo.file_id, groupFolder, fileName);
        content = caption || '[图片]';
        logger.info({ chatId, fileName, mediaPath }, 'Downloaded photo');
      } catch (err) {
        logger.error({ chatId, err }, 'Failed to download photo');
        content = '[图片下载失败]';
      }
    } else if ('document' in ctx.message) {
      const doc = ctx.message.document;
      const caption = ('caption' in ctx.message ? ctx.message.caption : '') || '';
      const fileName = `${ctx.message.message_id}_${doc.file_name || 'file'}`;

      try {
        mediaPath = await downloadTelegramFile(doc.file_id, groupFolder, fileName);
        content = caption || `[文件: ${doc.file_name || 'unknown'}]`;
        logger.info({ chatId, fileName, mediaPath }, 'Downloaded document');
      } catch (err) {
        logger.error({ chatId, err }, 'Failed to download document');
        content = `[文件下载失败: ${doc.file_name || 'unknown'}]`;
      }
    } else {
      // Unsupported message type (sticker, voice, etc.)
      logger.debug({ chatId, messageType: Object.keys(ctx.message) }, 'Unsupported message type');
      return;
    }

    // Store message in database
    deps.storeChatMetadata(chatId, timestamp);
    deps.storeMessageDirect({
      id: String(ctx.message.message_id),
      chatJid: chatId,
      sender: senderId,
      senderName,
      content,
      timestamp,
      isFromMe: false,
      mediaPath,
      replyToContent,
    });

    logger.info({ chatId, isGroup, senderName, hasMedia: !!mediaPath, replyTo: replyToContent }, `Telegram message: ${content.substring(0, 50)}...`);
  });

  // Start the bot
  telegrafBot.launch();
  logger.info('Telegram bot started');

  // Graceful shutdown
  process.once('SIGINT', () => {
    logger.info('Shutting down Telegram bot');
    telegrafBot.stop('SIGINT');
  });
  process.once('SIGTERM', () => {
    logger.info('Shutting down Telegram bot');
    telegrafBot.stop('SIGTERM');
  });
}

export async function telegramSendMessage(chatId: string, text: string): Promise<void> {
  await telegrafBot.telegram.sendMessage(chatId, text);
}

export async function telegramSendFile(chatId: string, filePath: string, isImage: boolean, caption?: string): Promise<void> {
  const inputFile = Input.fromLocalFile(filePath);
  if (isImage) {
    await telegrafBot.telegram.sendPhoto(chatId, inputFile, { caption });
  } else {
    await telegrafBot.telegram.sendDocument(chatId, inputFile, { caption });
  }
}

export async function telegramSetTyping(chatId: string): Promise<void> {
  await telegrafBot.telegram.sendChatAction(chatId, 'typing');
}
