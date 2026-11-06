'use client'

import { Dispatch, ReactNode, SetStateAction, createContext, useCallback, useContext, useState } from "react"
import Modal from "./Modal"
import { createGroup } from "../server-actions/groupsCRUD"
import { Group } from "../lib/types"
import { useGroups } from "../swr/useGroups"

export interface GroupModalArgs {
  onSave?: (group: Group) => void
  onCloseCallback?: () => void
}

// Create contexts for modal state management
const ModalIsShowingContext = createContext(false)
const SetModalIsShowingContext = createContext<Dispatch<SetStateAction<boolean>>>(() => {})
const ModalArgsContext = createContext<GroupModalArgs | null>(null)
const SetModalArgsContext = createContext<Dispatch<SetStateAction<GroupModalArgs | null>>>(() => {})

const CustomizedModal = () => {
  const [groupName, setGroupName] = useState("")
  const [groupType, setGroupType] = useState<"group" | "block" | "none">("none")

  const { mutate: mutateGroups } = useGroups()

  const {
    hideGroupModal,
    groupModalArgs,
    groupModalIsShowing
  } = useGroupModal()

  const handleCloseModal = () => {
    setGroupName("") // Reset form
    setGroupType("none") // Reset to default
    hideGroupModal()
    if(groupModalArgs?.onCloseCallback) {
      groupModalArgs.onCloseCallback()
    }
  }

  const handleSave = async (groupName: string) => {
    if(!groupName.trim()) {
      console.error('Group name is required')
      return
    }

    // save the group to the database
    const createGroupResults = await createGroup({
      name: groupName.trim(),
      type: groupType === "none" ? '' : groupType
    })

    if('error' in createGroupResults) {
      alert('Could not create group. ' + createGroupResults.error + '. Please try again.');
      return
    }

    // refetch the groups swr
    mutateGroups()

    if (groupModalArgs?.onSave) {
      groupModalArgs.onSave(createGroupResults)
    }
    handleCloseModal()
  }

  return (
    <Modal
      isOpen={groupModalIsShowing}
      closeModal={handleCloseModal}
      maxWidth="lg"
      closeButtonText={null}
    >
      <div className="space-y-6">
        <div>
          <h2 className="text-xl font-bold">Create New Group</h2>
          <p className="text-sm text-gray-500">Create a new group to organize your sensor-valve pairings</p>
        </div>

        {/* Group Information Section */}
        <div className="p-4 bg-white rounded-lg border border-gray-200">
          <h3 className="text-md font-semibold mb-3">Group Information</h3>

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Prefix</label>
              <div className="flex w-full space-x-4">
                <label
                    className={`flex-1 flex items-center p-3 border rounded-md cursor-pointer transition-colors duration-200 ease-in-out hover:bg-gray-50 ${groupType === "none" ? "border-blue-500 bg-blue-50" : "border-gray-300"}`}
                  >
                    <input
                      type="radio"
                      name="groupType"
                      value="none"
                      checked={groupType === "none"}
                      onChange={() => setGroupType("none")}
                      className="h-4 w-4 text-blue-600 border-gray-300 focus:ring-blue-500"
                    />
                    <span className="ml-2 block text-sm font-medium">None</span>
                </label>

                <label
                  className={`flex-1 flex items-center p-3 border rounded-md cursor-pointer transition-colors duration-200 ease-in-out hover:bg-gray-50 ${groupType === "group" ? "border-blue-500 bg-blue-50" : "border-gray-300"}`}
                >
                  <input
                    type="radio"
                    name="groupType"
                    value="group"
                    checked={groupType === "group"}
                    onChange={() => setGroupType("group")}
                    className="h-4 w-4 text-blue-600 border-gray-300 focus:ring-blue-500"
                  />
                  <span className="ml-2 block text-sm font-medium">Group</span>
                </label>

                <label
                  className={`flex-1 flex items-center p-3 border rounded-md cursor-pointer transition-colors duration-200 ease-in-out hover:bg-gray-50 ${groupType === "block" ? "border-blue-500 bg-blue-50" : "border-gray-300"}`}
                >
                  <input
                    type="radio"
                    name="groupType"
                    value="block"
                    checked={groupType === "block"}
                    onChange={() => setGroupType("block")}
                    className="h-4 w-4 text-blue-600 border-gray-300 focus:ring-blue-500"
                  />
                  <span className="ml-2 block text-sm font-medium">Block</span>
                </label>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700">Group Name</label>
              <input
                type="text"
                value={groupName}
                onChange={(e) => setGroupName(e.target.value)}
                className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500"
                placeholder="Enter a descriptive name for this group"
              />
            </div>
          </div>
        </div>

        <div className="flex justify-end space-x-3 pt-2">
          <button
            onClick={() => handleCloseModal()}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded hover:bg-gray-200"
          >
            Cancel
          </button>
          <button
            onClick={() => handleSave(groupName)}
            className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded hover:bg-blue-700"
            disabled={!groupName.trim()}
          >
            Save Group
          </button>
        </div>
      </div>
    </Modal>
  )
}

export const GroupModalProvider = ({ children }: { children: ReactNode }) => {
  const [isShowing, setIsShowing] = useState(false)
  const [modalArgs, setModalArgs] = useState<GroupModalArgs | null>(null)

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

export const useGroupModal = () => {
  const groupModalArgs = useContext(ModalArgsContext)
  const setGroupModalArgs = useContext(SetModalArgsContext)
  const setIsShowing = useContext(SetModalIsShowingContext)
  const groupModalIsShowing = useContext(ModalIsShowingContext)

  const showGroupModal = useCallback((input: GroupModalArgs | null) => {
    setGroupModalArgs(input)
    setIsShowing(true)
  }, [setGroupModalArgs, setIsShowing])

  const hideGroupModal = useCallback(() => {
    setIsShowing(false)
  }, [setIsShowing])

  return {
    groupModalArgs,
    hideGroupModal,
    showGroupModal,
    groupModalIsShowing
  }
}