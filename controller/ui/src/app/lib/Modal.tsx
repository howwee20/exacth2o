import React, { ReactNode, MouseEvent } from "react"

/**
 * Props for the generic Modal component.
 */
export interface ModalProps {
  /**
   * Whether the modal is open (visible).
   */
  isOpen: boolean
  /**
   * Function to run when the modal should close, e.g., user clicks the background or the close button.
   */
  closeModal: () => void
  /**
   * Optional text for the close button.
   * Defaults to "Close".
   */
  closeButtonText?: string | null
  /**
   * Specify a max width via Tailwind classes, e.g. "md", "lg", "2xl", etc.
   * Defaults to "md".
   */
  maxWidth?: string
  /**
   * The content that appears inside the modal (e.g., forms, text, etc.)
   */
  children?: ReactNode
}

export default function Modal({
  isOpen,
  closeModal,
  closeButtonText = "Close",
  maxWidth = "md",
  children,
}: ModalProps) {
  if (!isOpen) return null

  // Convert the maxWidth prop to a corresponding Tailwind class.
  const maxWidthClass = {
    sm: "max-w-sm",
    md: "max-w-md",
    lg: "max-w-lg",
    xl: "max-w-xl",
    "2xl": "max-w-2xl",
  }[maxWidth] ?? "max-w-md"

  // Close modal if user clicks the dark backdrop (excluding the modal container).
  const handleBackgroundClick = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) {
      closeModal()
    }
  }

 return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50"
      onClick={(e) => handleBackgroundClick(e)}
    >
      <div
        className={`relative w-full ${maxWidthClass} bg-white rounded-md shadow-lg p-6 mx-4`}
      >
        <button
          className="absolute top-4 right-4 text-gray-600 hover:text-gray-800"
          onClick={() => closeModal()}
        >
          ✕
        </button>
        {children}
        {closeButtonText && (
          <div className="mt-4 flex justify-end">
            <button
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded hover:bg-blue-700"
              onClick={() => closeModal()}
            >
              {closeButtonText}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}