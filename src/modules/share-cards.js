(function initChatVaultShareCards() {
  "use strict";

  const SOCIAL_PRESETS = {
    linkedin_carousel: {
      id: "linkedin_carousel",
      label: "LinkedIn Carousel (4:5)",
      aspectRatio: "4:5",
      width: 1080,
      height: 1350,
      split: true,
      maxCards: 12,
      showPageNumber: true
    },
    instagram_story: {
      id: "instagram_story",
      label: "Instagram / Mobile Story (9:16)",
      aspectRatio: "9:16",
      width: 1080,
      height: 1920,
      split: true,
      maxCards: 10,
      showPageNumber: true
    },
    xiaohongshu_card: {
      id: "xiaohongshu_card",
      label: "小红书卡片 (3:4)",
      aspectRatio: "3:4",
      width: 1200,
      height: 1600,
      split: true,
      maxCards: 9,
      showPageNumber: false
    },
    twitter_card: {
      id: "twitter_card",
      label: "Twitter / X Post (16:9)",
      aspectRatio: "16:9",
      width: 1200,
      height: 675,
      split: false,
      maxCards: 1,
      showPageNumber: false
    }
  };

  // 预估单条消息渲染所需的高度
  function estimateMessageHeight(msg) {
    let charCount = 0;
    let imageCount = 0;
    let codeBlockCount = 0;

    if (Array.isArray(msg.contentBlocks)) {
      msg.contentBlocks.forEach((block) => {
        if (block.type === "image") imageCount++;
        else if (block.type === "code") {
          codeBlockCount++;
          charCount += (block.text || "").length;
        } else if (block.text) {
          charCount += block.text.length;
        }
      });
    }

    // 基础高度 100px + 字符折行高度 + 代码块高度 + 图像高度
    return 80 + (charCount * 0.45) + (codeBlockCount * 180) + (imageCount * 300);
  }

  // 核心分割算法：将 messages 按最大高度限制分割成多页，返回数组，数组中每个元素为 message 索引子集 [[0, 1, 2], [3, 4]]
  function calculateImageSplits(messages, maxHeight = 6000) {
    const pages = [];
    let currentPage = [];
    let currentHeight = 0;

    (messages || []).forEach((msg, idx) => {
      const msgHeight = estimateMessageHeight(msg);
      
      // 如果加起来超出了单张图片最大高度限制，则新起一页
      if (currentHeight + msgHeight > maxHeight && currentPage.length > 0) {
        pages.push(currentPage);
        currentPage = [idx];
        currentHeight = msgHeight;
      } else {
        currentPage.push(idx);
        currentHeight += msgHeight;
      }
    });

    if (currentPage.length > 0) {
      pages.push(currentPage);
    }

    return pages;
  }

  globalThis.CHATVAULT_SHARE_CARDS = {
    SOCIAL_PRESETS,
    calculateImageSplits,
    estimateMessageHeight
  };
})();
