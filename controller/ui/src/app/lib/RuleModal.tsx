'use client'

import { Dispatch, ReactNode, SetStateAction, createContext, useCallback, useContext, useState } from "react"
import Modal from "./Modal"
import { createRule } from "../server-actions/rulesCRUD";
import { Rule } from "./types";

function uuidv4() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

export interface RuleModalArgs {
  onSave?: (rule: Rule) => void
  onCloseCallback?: () => void
}

// Create contexts for modal state management
const ModalIsShowingContext = createContext(false)
const SetModalIsShowingContext = createContext<Dispatch<SetStateAction<boolean>>>(() => {})
const ModalArgsContext = createContext<RuleModalArgs | null>(null)
const SetModalArgsContext = createContext<Dispatch<SetStateAction<RuleModalArgs | null>>>(() => {})

const CustomizedModal = () => {
  const [ruleText, setRuleText] = useState("")
  const [ruleId, setRuleId] = useState(() => uuidv4()) // Generate UUID on mount

  const {
    hideRuleModal,
    ruleModalArgs,
    ruleModalIsShowing
  } = useRuleModal()

  const handleCloseModal = () => {
    setRuleId(uuidv4()) // Reset id to a new UUID
    setRuleText("") // Reset form
    hideRuleModal()
    if(ruleModalArgs?.onCloseCallback) {
      ruleModalArgs.onCloseCallback()
    }
  }

  const handleSave = async (ruleId: string, ruleText: string) => {

    // get the input values from the form

    if(!ruleId || !ruleText) {
      console.error('ruleId or ruleText is not set')
      return
    }

    // validate that the ruleText is valid JSON
    try {
      JSON.parse(ruleText)
    } catch (error) {
      console.error('ruleText is not valid JSON', error)
      return
    }

    // save the rule to the database
    const creatRuleResults = await createRule(ruleId, {
      rule: JSON.parse(ruleText)
    })

    if (ruleModalArgs?.onSave) {
      ruleModalArgs.onSave(creatRuleResults)
    }
    handleCloseModal()
  }

  return (
    <Modal
      isOpen={ruleModalIsShowing}
      closeModal={handleCloseModal}
      maxWidth="lg"
      closeButtonText={null}
    >
      <div className="space-y-4">
        <h2 className="text-xl font-bold">Create New Rule</h2>

        <div>
          <label className="block text-sm font-medium text-gray-700">Rule ID</label>
          <input
            type="text"
            value={ruleId}
            disabled
            className="mt-1 block w-full rounded-md border-gray-300 bg-gray-100 shadow-sm"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700">Rule</label>
          <input
            type="text"
            value={ruleText}
            onChange={(e) => setRuleText(e.target.value)}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500"
            placeholder="Enter your rule here"
          />
        </div>

        <div className="flex justify-end space-x-3">
          <button
            onClick={() => handleCloseModal()}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded hover:bg-gray-200"
          >
            Cancel
          </button>
          <button
            onClick={() => handleSave(ruleId, ruleText)}
            className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded hover:bg-blue-700"
          >
            Save Rule
          </button>
        </div>
      </div>
    </Modal>
  )
}

export const RuleModalProvider = ({ children }: { children: ReactNode }) => {
  const [isShowing, setIsShowing] = useState(false)
  const [modalArgs, setModalArgs] = useState<RuleModalArgs | null>(null)

  return (
    <ModalIsShowingContext.Provider value={isShowing}>
      <SetModalIsShowingContext.Provider value={setIsShowing}>
        <ModalArgsContext.Provider value={modalArgs}>
          <SetModalArgsContext.Provider value={setModalArgs}>
            <CustomizedModal />
            {children}
          </SetModalArgsContext.Provider>
        </ModalArgsContext.Provider>
      </SetModalIsShowingContext.Provider>
    </ModalIsShowingContext.Provider>
  )
}

export const useRuleModal = () => {
  const ruleModalArgs = useContext(ModalArgsContext)
  const setRuleModalArgs = useContext(SetModalArgsContext)
  const setIsShowing = useContext(SetModalIsShowingContext)
  const ruleModalIsShowing = useContext(ModalIsShowingContext)

  const showRuleModal = useCallback((input: RuleModalArgs | null) => {
    setRuleModalArgs(input)
    setIsShowing(true)
  }, [setRuleModalArgs, setIsShowing])

  const hideRuleModal = useCallback(() => {
    setIsShowing(false)
  }, [setIsShowing])

  return {
    ruleModalArgs,
    hideRuleModal,
    showRuleModal,
    ruleModalIsShowing
  }
}