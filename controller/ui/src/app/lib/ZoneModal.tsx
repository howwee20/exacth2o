'use client'

import { Dispatch, ReactNode, SetStateAction, createContext, useCallback, useContext, useState } from "react"
import Modal from "./Modal"
import { createZone } from "../server-actions/zonesCRUD"
import { Zone } from "../lib/types"

function uuidv4() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

export interface ZoneModalArgs {
  onSave?: (zone: Zone) => void
  onCloseCallback?: () => void
}

// Create contexts for modal state management
const ModalIsShowingContext = createContext(false)
const SetModalIsShowingContext = createContext<Dispatch<SetStateAction<boolean>>>(() => {})
const ModalArgsContext = createContext<ZoneModalArgs | null>(null)
const SetModalArgsContext = createContext<Dispatch<SetStateAction<ZoneModalArgs | null>>>(() => {})

const CustomizedModal = () => {
  const [zoneName, setZoneName] = useState("")
  const [zoneDescription, setZoneDescription] = useState("")
  const [zoneId, setZoneId] = useState(() => uuidv4()) // Generate UUID on mount

  const {
    hideZoneModal,
    zoneModalArgs,
    zoneModalIsShowing
  } = useZoneModal()

  const handleCloseModal = () => {
    setZoneId(uuidv4()) // Reset id to a new UUID
    setZoneName("") // Reset form
    setZoneDescription("") // Reset description
    hideZoneModal()
    if(zoneModalArgs?.onCloseCallback) {
      zoneModalArgs.onCloseCallback()
    }
  }

  const handleSave = async (zoneId: string, zoneName: string, zoneDescription: string) => {
    if(!zoneId || !zoneName.trim()) {
      console.error('zoneId or zoneName is not set')
      return
    }

    // save the zone to the database
    const createZoneResults = await createZone({
      //@ts-expect-error - id is not required
      id: zoneId,
      name: zoneName.trim(),
      description: zoneDescription.trim()
    })

    if (zoneModalArgs?.onSave) {
      zoneModalArgs.onSave(createZoneResults)
    }
    handleCloseModal()
  }

  return (
    <Modal
      isOpen={zoneModalIsShowing}
      closeModal={handleCloseModal}
      maxWidth="lg"
      closeButtonText={null}
    >
      <div className="space-y-4">
        <h2 className="text-xl font-bold">Create New Zone</h2>

        <div>
          <label className="block text-sm font-medium text-gray-700">Zone ID</label>
          <input
            type="text"
            value={zoneId}
            disabled
            className="mt-1 block w-full rounded-md border-gray-300 bg-gray-100 shadow-sm"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700">Zone Name</label>
          <input
            type="text"
            value={zoneName}
            onChange={(e) => setZoneName(e.target.value)}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500"
            placeholder="Enter zone name"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700">Description</label>
          <textarea
            value={zoneDescription}
            onChange={(e) => setZoneDescription(e.target.value)}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500"
            placeholder="Enter zone description"
            rows={3}
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
            onClick={() => handleSave(zoneId, zoneName, zoneDescription)}
            className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded hover:bg-blue-700"
          >
            Save Zone
          </button>
        </div>
      </div>
    </Modal>
  )
}

export const ZoneModalProvider = ({ children }: { children: ReactNode }) => {
  const [isShowing, setIsShowing] = useState(false)
  const [modalArgs, setModalArgs] = useState<ZoneModalArgs | null>(null)

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

export const useZoneModal = () => {
  const zoneModalArgs = useContext(ModalArgsContext)
  const setZoneModalArgs = useContext(SetModalArgsContext)
  const setIsShowing = useContext(SetModalIsShowingContext)
  const zoneModalIsShowing = useContext(ModalIsShowingContext)

  const showZoneModal = useCallback((input: ZoneModalArgs | null) => {
    setZoneModalArgs(input)
    setIsShowing(true)
  }, [setZoneModalArgs, setIsShowing])

  const hideZoneModal = useCallback(() => {
    setIsShowing(false)
  }, [setIsShowing])

  return {
    zoneModalArgs,
    hideZoneModal,
    showZoneModal,
    zoneModalIsShowing
  }
}