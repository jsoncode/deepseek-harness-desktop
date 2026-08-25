import { Modal, type ModalProps } from "antd";
import type { CSSProperties } from "react";

/** antd Modal 语义部位样式（对象形式；antd 6 的 styles 还允许函数形式，这里只透传对象） */
interface AppModalStyles {
  root?: CSSProperties;
  header?: CSSProperties;
  body?: CSSProperties;
  footer?: CSSProperties;
  container?: CSSProperties;
  title?: CSSProperties;
  wrapper?: CSSProperties;
  mask?: CSSProperties;
  close?: CSSProperties;
}

export interface AppModalProps extends Omit<ModalProps, "styles"> {
  /** 覆盖弹框各部位样式；未覆盖项保持本组件的默认布局 */
  styles?: AppModalStyles;
}

/**
 * 公共弹框：整体最大高度 80vh，header / footer 固定，body 内部滚动。
 *
 * 基于 antd Modal 封装，通过 container 的 flex 列布局实现：
 * - container：max-height 80vh + flex column（弹框整体不超出视口 80%）
 * - header / footer：flex-shrink 0（固定在上下两端，不随内容滚动）
 * - body：flex 1 + overflow-y auto（内容超高时在 body 内滚动）
 *
 * 透传其余 ModalProps（open / width / title / footer / onCancel 等）。
 */
export default function AppModal({ styles, ...rest }: AppModalProps) {
  return (
    <Modal
      {...rest}
      styles={{
        ...styles,
        container: {
          maxHeight: "80vh",
          display: "flex",
          flexDirection: "column",
          ...styles?.container,
        },
        header: {
          flexShrink: 0,
          ...styles?.header,
        },
        body: {
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          ...styles?.body,
        },
        footer: {
          flexShrink: 0,
          ...styles?.footer,
        },
      }}
    />
  );
}
