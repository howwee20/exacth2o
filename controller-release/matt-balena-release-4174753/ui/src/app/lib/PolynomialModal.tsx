'use client'

import { Dispatch, ReactNode, SetStateAction, createContext, useCallback, useContext, useState } from "react"
import Modal from "./Modal"

export interface PolynomialModalArgs {
  onConfirm?: (coefficients: number[]) => void
}

// Create contexts for modal state management
const ModalIsShowingContext = createContext(false)
const SetModalIsShowingContext = createContext<Dispatch<SetStateAction<boolean>>>(() => {})
const ModalArgsContext = createContext<PolynomialModalArgs | null>(null)
const SetModalArgsContext = createContext<Dispatch<SetStateAction<PolynomialModalArgs | null>>>(() => {})

const CustomizedModal = () => {
  // Initialize state for each coefficient (a0 + a1*x + a2*x^2 + a3*x^3 + a4*x^4 + a5*x^5)
  // Where index 0 is constant term, 1 is x term, etc.
  const [coefficients, setCoefficients] = useState<string[]>(["", "", "", "", "", ""])

  const {
    polynomialModalIsShowing,
    hidePolynomialModal,
    polynomialModalArgs
  } = usePolynomialModal()

  const handleClose = () => {
    setCoefficients(["", "", "", "", "", ""])
    hidePolynomialModal()
  }

  const handleConfirm = () => {
    console.log('handleConfirm')
    if (!polynomialModalArgs?.onConfirm) return

    // Convert coefficients to numbers
    // (coefficients[0] is constant term, coefficients[1] is x term, etc.)
    const coeffArray = coefficients.map(coeff => coeff.trim() === "" ? 0 : parseFloat(coeff))
    console.log('coeffArray', coeffArray)
    // Call the callback with the coefficients
    polynomialModalArgs.onConfirm(coeffArray)
    handleClose()
  }

  const handleCoefficientChange = (index: number, value: string) => {
    const newCoefficients = [...coefficients]
    newCoefficients[index] = value
    setCoefficients(newCoefficients)
  }

  return (
    <Modal
      isOpen={polynomialModalIsShowing}
      closeModal={handleClose}
      maxWidth="md"
      closeButtonText={null}
    >
      <div className="space-y-6">
        <div>
          <h2 className="text-xl font-bold">Enter Polynomial</h2>
          <p className="text-sm text-gray-500">
            Fill in the coefficients for your desired polynomial. Leave fields blank for terms you don&apos;t want to include.
          </p>
        </div>

        <div className="p-4 bg-white rounded-lg border border-gray-200">
          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 mb-2">Polynomial Function</label>
            <div className="flex flex-col items-center gap-2">
              <span className="text-lg">y = </span>

              {/* x^5 term */}
              <div className="flex items-center">
                <input
                  type="number"
                  step="0.0001"
                  value={coefficients[5]}
                  onChange={(e) => handleCoefficientChange(5, e.target.value)}
                  className="w-20 rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500"
                  placeholder="0"
                />
                <span className="ml-1">x<sup>5</sup></span>
              </div>

              <span>+</span>

              {/* x^4 term */}
              <div className="flex items-center">
                <input
                  type="number"
                  step="0.0001"
                  value={coefficients[4]}
                  onChange={(e) => handleCoefficientChange(4, e.target.value)}
                  className="w-20 rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500"
                  placeholder="0"
                />
                <span className="ml-1">x<sup>4</sup></span>
              </div>

              <span>+</span>

              {/* x^3 term */}
              <div className="flex items-center">
                <input
                  type="number"
                  step="0.0001"
                  value={coefficients[3]}
                  onChange={(e) => handleCoefficientChange(3, e.target.value)}
                  className="w-20 rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500"
                  placeholder="0"
                />
                <span className="ml-1">x<sup>3</sup></span>
              </div>

              <span>+</span>

              {/* x^2 term */}
              <div className="flex items-center">
                <input
                  type="number"
                  step="0.0001"
                  value={coefficients[2]}
                  onChange={(e) => handleCoefficientChange(2, e.target.value)}
                  className="w-20 rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500"
                  placeholder="0"
                />
                <span className="ml-1">x<sup>2</sup></span>
              </div>

              <span>+</span>

              {/* x term */}
              <div className="flex items-center">
                <input
                  type="number"
                  step="0.0001"
                  value={coefficients[1]}
                  onChange={(e) => handleCoefficientChange(1, e.target.value)}
                  className="w-20 rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500"
                  placeholder="0"
                />
                <span className="ml-1">x</span>
              </div>

              <span>+</span>

              {/* constant term */}
              <div className="flex items-center">
                <input
                  type="number"
                  step="0.0001"
                  value={coefficients[0]}
                  onChange={(e) => handleCoefficientChange(0, e.target.value)}
                  className="w-20 rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500"
                  placeholder="0"
                />
              </div>
            </div>
          </div>
          <p className="text-xs text-gray-500 mt-2">
            Note: You only need to fill in the coefficients for the terms you want to include. Leave the others blank.
          </p>
          <p className="text-xs text-gray-500 mt-2">
            For example: y = 3x<sup>2</sup> + 2x + 1<br/>
            Would be entered as:
            [blank], [blank], [blank], 3, 2, 1,
          </p>
        </div>

        <div className="flex justify-end space-x-3 pt-2">
          <button
            onClick={handleClose}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded hover:bg-gray-200"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded hover:bg-blue-700"
          >
            Confirm
          </button>
        </div>
      </div>
    </Modal>
  )
}

export const PolynomialModalProvider = ({ children }: { children: ReactNode }) => {
  const [isShowing, setIsShowing] = useState(false)
  const [modalArgs, setModalArgs] = useState<PolynomialModalArgs | null>(null)

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

export const usePolynomialModal = () => {
  const polynomialModalArgs = useContext(ModalArgsContext)
  const setPolynomialModalArgs = useContext(SetModalArgsContext)
  const setIsShowing = useContext(SetModalIsShowingContext)
  const polynomialModalIsShowing = useContext(ModalIsShowingContext)

  const showPolynomialModal = useCallback((input: PolynomialModalArgs) => {
    setPolynomialModalArgs(input)
    setIsShowing(true)
  }, [setPolynomialModalArgs, setIsShowing])

  const hidePolynomialModal = useCallback(() => {
    setIsShowing(false)
  }, [setIsShowing])

  return {
    polynomialModalArgs,
    hidePolynomialModal,
    showPolynomialModal,
    polynomialModalIsShowing
  }
}