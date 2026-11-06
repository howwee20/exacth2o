'use client'

import { Dispatch, ReactNode, SetStateAction, createContext, useCallback, useContext, useState } from "react"
import Modal from "./Modal"

export interface GenericModalArgs {
  mainText: string
  subText?: string | ReactNode
  confirmButtonText: string
  cancelButtonText?: string
  onConfirmCallback: () => void
  onCancelCallback?: () => void
  overrideZIndex?: number
}

const ModalIsShowingContext = createContext(false)
const SetModalIsShowingContext = createContext<Dispatch<SetStateAction<boolean>>
>(() => {})
const ModalArgsContext = createContext<GenericModalArgs | null>(null)
const SetModalArgsContext = createContext<Dispatch<SetStateAction<GenericModalArgs | null>>
>(() => {})

const CustomizedModal = () => {

  const {
    hideGenericModal,
    genericModalArgs,
    genericModalIsShowing
  } = useGenericModal()

  return (
    <Modal
      isOpen={genericModalIsShowing}
      closeModal={() => {
        hideGenericModal();
        (genericModalArgs?.onCancelCallback ?? genericModalArgs?.onConfirmCallback ?? (() => {}))()
      }}
      closeButtonText={null}
    >
      <div className="text-left">
        <p className="text-2xl font-bold mb-2">{genericModalArgs?.mainText}</p>
        {genericModalArgs?.subText && <p>{genericModalArgs?.subText}</p>}

        <div className="flex flex-row items-center justify-between pt-8">
          <button
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded hover:bg-gray-200"
            onClick={() => {
              genericModalArgs?.onCancelCallback?.()
              hideGenericModal()
            }}
            disabled={!genericModalArgs?.cancelButtonText}
          >
            <span>{genericModalArgs?.cancelButtonText ?? ''}</span>
          </button>
          <button
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded hover:bg-gray-200"
            onClick={() => {
              genericModalArgs?.onConfirmCallback()
              hideGenericModal()
            }}
          >
            <span>{genericModalArgs?.confirmButtonText}</span>
          </button>
        </div>
      </div>
    </Modal>
  )
}

export const GenericModalProvider = (props: {
  children: ReactNode
}) => {
  const [ isShowing, setIsShowing ] = useState(false)
  const [ modalArgs, setModalArgs ] = useState<GenericModalArgs | null>(null)

  return (
    <ModalIsShowingContext.Provider value={isShowing}>
      <SetModalIsShowingContext.Provider value={setIsShowing}>
        <ModalArgsContext.Provider value={modalArgs}>
          <SetModalArgsContext.Provider value={setModalArgs}>
            <CustomizedModal />
            {props.children}
          </SetModalArgsContext.Provider>
        </ModalArgsContext.Provider>
      </SetModalIsShowingContext.Provider>
    </ModalIsShowingContext.Provider>
  )
}

export const useGenericModal = () => {
  const genericModalArgs = useContext(ModalArgsContext)
  const setGenericModalArgs = useContext(SetModalArgsContext)
  const setIsShowing = useContext(SetModalIsShowingContext)
  const genericModalIsShowing = useContext(ModalIsShowingContext)

  const showGenericModal = useCallback((input: GenericModalArgs | null) => {
    setGenericModalArgs(input)
    setIsShowing(true)
  }, [ setGenericModalArgs, setIsShowing ])

  const hideGenericModal = useCallback(() => {
    setIsShowing(false)
  }, [ setIsShowing ])

  return {
    genericModalArgs,
    hideGenericModal,
    showGenericModal,
    genericModalIsShowing
  }
}
