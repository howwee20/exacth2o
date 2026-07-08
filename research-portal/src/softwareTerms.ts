export const supportEmail = "support@exacth2o.com";
export const softwareTermsVersion = "2026-07-07";

export type SoftwareTermsSection = {
  title: string;
  paragraphs: string[];
  items?: string[];
};

export const softwareTermsIntro = [
  "These Terms and Conditions govern access to and use of the Exact H2O LLC software platform, associated web applications, mobile applications, cloud services, hardware interfaces, and related services, whether accessed online or from local components provided by Exact H2O LLC.",
  "By accessing or using the Service, the user agrees to be bound by these Terms.",
];

export const softwareTermsSections: SoftwareTermsSection[] = [
  {
    title: "1. Purpose of Service",
    paragraphs: [
      "The Service provides monitoring, management, automation, analytics, and control of irrigation systems for research and production purposes.",
      "The Service is intended for trained personnel, researchers, scientists, technicians, and authorized staff operating irrigation and plant growth systems.",
    ],
  },
  {
    title: "2. License Grant",
    paragraphs: [
      "Subject to these Terms and payment of applicable fees, Exact H2O LLC grants Customer a limited, non-exclusive, non-transferable, revocable license to access and use the Service solely for Customer's internal research, educational, commercial, or operational purposes.",
      "All rights not expressly granted remain the exclusive property of Exact H2O LLC except for portions owned by third-party licensors. All intellectual property rights in Third-Party Technology remain vested in the applicable third-party licensors.",
    ],
    items: [
      "Customer shall not copy, modify, distribute, sell, sublicense, or lease the Service.",
      "Customer shall not reverse engineer, decompile, or attempt to discover source code.",
      "Customer shall not circumvent security or authentication mechanisms.",
      "Customer shall not use the Service in violation of applicable laws or regulations.",
      "Customer shall not permit unauthorized third parties to access the Service.",
    ],
  },
  {
    title: "3. Ownership of Intellectual Property",
    paragraphs: [
      "The Service, including software, algorithms, user interfaces, documentation, designs, trademarks, and associated intellectual property, remains the sole property of Exact H2O LLC.",
      "Customer retains ownership of its original research data, experimental records, and scientific results generated through use of the Service, subject to the data rights described below.",
      "The Software may incorporate software, algorithms, models, databases, intellectual property, interfaces, or other technology licensed from third-party providers. Such Third-Party Technology remains the property of its respective owners and licensors.",
      "Customer shall comply with any applicable restrictions, license terms, and usage limitations associated with Third-Party Technology incorporated into the Software.",
    ],
  },
  {
    title: "4. Data Rights and Use",
    paragraphs: [
      "Customer acknowledges that operation of the Service may generate, collect, process, and store data including irrigation settings, water application records, sensor measurements, environmental conditions, device performance metrics, user interactions, equipment diagnostics, experimental configuration metadata, and aggregated operational outcomes.",
      "Customer grants Exact H2O LLC a perpetual, worldwide, irrevocable, royalty-free license to use, analyze, process, store, aggregate, and anonymize such data.",
      "Exact H2O LLC may use aggregated or anonymized data for research, publications, technical reports, presentations, marketing materials, and commercial product development, provided that individual customers are not publicly identified without prior written consent.",
      "Nothing in these Terms transfers ownership of Exact H2O LLC's derived models, analytics, algorithms, or machine learning outputs to Customer.",
    ],
    items: [
      "Improve existing products and services.",
      "Develop new products, services, algorithms, and features.",
      "Train, validate, test, and improve machine learning and artificial intelligence models.",
      "Develop predictive irrigation recommendations and automation systems.",
      "Perform benchmarking and performance analyses.",
    ],
  },
  {
    title: "5. Scientific Use and User Responsibilities",
    paragraphs: [
      "Customer agrees to operate equipment in accordance with manufacturer instructions, ensure personnel are appropriately trained, maintain appropriate backups of research and experimental data, follow applicable safety protocols and institutional policies, and maintain reasonable security of login credentials and associated hardware.",
      "Customer bears sole responsibility for experimental design, scientific conclusions, irrigation strategies implemented through the Service, regulatory compliance applicable to its operations, and repairs required following operation of the system outside manufacturer recommendations.",
    ],
  },
  {
    title: "6. Experimental Liability",
    paragraphs: [
      "The Service may generate recommendations, forecasts, alerts, or automated irrigation settings. Such recommendations are advisory and do not create liability regarding their presence or absence.",
      "Users should evaluate all recommendations using professional judgment and appropriate scientific oversight.",
    ],
    items: [
      "Exact H2O LLC does not assume liability for costs resulting from alarms that did not activate.",
      "Exact H2O LLC does not assume liability for delays in experiments caused by faulty sensors.",
      "Exact H2O LLC does not assume liability for costs due to incorrect sensor calibrations.",
      "Exact H2O LLC does not assume liability for loss caused by environmental, biological, technical, or operational factors.",
    ],
  },
  {
    title: "7. Account Security",
    paragraphs: [
      "Customer is responsible for maintaining confidentiality of account credentials, restricting access to authorized users, promptly reporting unauthorized access or security incidents, and all activity occurring under its accounts.",
    ],
  },
  {
    title: "8. Service Availability",
    paragraphs: [
      "Exact H2O LLC will make commercially reasonable efforts to maintain Service availability. The Service may occasionally be unavailable due to maintenance, hardware failures, software updates, internet disruptions, third-party service interruptions, or force majeure events.",
      "Exact H2O LLC does not guarantee uninterrupted or error-free operation.",
      "Exact H2O LLC may modify, replace, suspend, or discontinue functionality that depends upon third-party technology if such technology becomes unavailable, commercially impractical, restricted, or discontinued.",
    ],
  },
  {
    title: "9. Software Updates",
    paragraphs: [
      "Exact H2O LLC may deploy updates, patches, feature enhancements, security improvements, and modifications at any time.",
      "Customer acknowledges that updates may modify functionality, interfaces, recommendations, or performance characteristics.",
    ],
  },
  {
    title: "10. Confidential Information",
    paragraphs: [
      "Each party agrees to protect confidential information received from the other party using reasonable care. Confidential information does not include information that is publicly available, independently developed, lawfully obtained from a third party, or required to be disclosed by law or court order.",
      "Exact H2O LLC will not disclose Customer's identity, confidential research information, unpublished experimental results, or proprietary research data to third-party technology providers except as necessary to operate the Software, provide support, comply with law, or as otherwise authorized by Customer.",
    ],
  },
  {
    title: "11. Limitation of Liability",
    paragraphs: [
      "In no event shall Exact H2O LLC's total liability arising from the Service exceed the amount paid by Customer to Exact H2O LLC during the twelve months preceding the event giving rise to the claim.",
    ],
    items: [
      "To the maximum extent permitted by law, Exact H2O LLC shall not be liable for lost profits.",
      "To the maximum extent permitted by law, Exact H2O LLC shall not be liable for lost research opportunities.",
      "To the maximum extent permitted by law, Exact H2O LLC shall not be liable for lost experimental data.",
      "To the maximum extent permitted by law, Exact H2O LLC shall not be liable for crop losses.",
      "To the maximum extent permitted by law, Exact H2O LLC shall not be liable for business interruption, consequential damages, incidental damages, special damages, or indirect damages.",
    ],
  },
  {
    title: "12. Disclaimer of Warranties",
    paragraphs: [
      'The Service is provided "AS IS" and "AS AVAILABLE."',
      "Exact H2O LLC disclaims all warranties, express or implied, including merchantability, fitness for a particular purpose, non-infringement, accuracy of outputs, and continuous availability.",
      "No oral or written information provided by Exact H2O LLC creates any warranty not expressly stated in these Terms.",
    ],
  },
  {
    title: "13. Indemnification",
    paragraphs: [
      "Customer agrees to defend, indemnify, and hold harmless Exact H2O LLC and its officers, employees, contractors, and affiliates from claims arising from improper use of the Service, violation of these Terms, Customer research activities, Customer irrigation decisions, or Customer negligence or misconduct.",
    ],
  },
  {
    title: "14. Compliance with Laws",
    paragraphs: [
      "Customer shall comply with all applicable laws, regulations, institutional requirements, and research policies related to use of the Service and associated equipment.",
    ],
  },
  {
    title: "15. Suspension and Termination",
    paragraphs: [
      "Exact H2O LLC may suspend or terminate access if Customer violates these Terms, misuses the Service, compromises system security, or fails to pay applicable fees.",
      "Upon termination, Customer's license to access the Service immediately ends. Sections concerning intellectual property, liability limitations, confidentiality, indemnification, and data rights shall survive termination.",
    ],
  },
  {
    title: "16. Governing Law",
    paragraphs: [
      "These Terms shall be governed by and construed under the laws of the State of Michigan, without regard to conflict-of-law principles.",
      "Any legal action arising from these Terms shall be brought exclusively in the state or federal courts located in Michigan.",
    ],
  },
  {
    title: "17. Modifications to Terms",
    paragraphs: [
      "Exact H2O LLC may update these Terms periodically. Continued use of the Service after notification of revised Terms constitutes acceptance of the revised Terms.",
    ],
  },
  {
    title: "18. Entire Agreement",
    paragraphs: [
      "These Terms constitute the entire agreement between Customer and Exact H2O LLC regarding the Service and supersede all prior discussions, proposals, or agreements concerning the subject matter.",
      "By creating an account, accessing the Service, or using Exact H2O LLC equipment, Customer acknowledges that it has read, understood, and agreed to these Terms and Conditions.",
    ],
  },
];

export const softwareTermsCompany = [
  "Exact H2O LLC",
  supportEmail,
  "https://exacth2o.com",
];
